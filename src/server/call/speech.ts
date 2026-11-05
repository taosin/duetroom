import * as sdk from "microsoft-cognitiveservices-speech-sdk";

export interface Voice {
  id: string;
  name: string;
  locale: string;
  styles: string[];
}
function credentials() {
  const region = process.env.AZURE_SPEECH_REGION?.trim();
  const key = process.env.AZURE_SPEECH_KEY?.trim();
  if (!region || !/^[a-z][a-z0-9-]{1,45}$/.test(region) || !key)
    throw Error("speech_unconfigured");
  return { region, key };
}
let catalog:
  { region: string; expires: number; values: Promise<Voice[]> } | undefined;
export async function voices(): Promise<Voice[]> {
  const { region, key } = credentials();
  if (catalog?.region === region && catalog.expires > Date.now())
    return catalog.values;
  const values = (async () => {
    const res = await fetch(
      "https://" +
        region +
        ".tts.speech.microsoft.com/cognitiveservices/voices/list",
      {
        headers: { "Ocp-Apim-Subscription-Key": key },
        signal: AbortSignal.timeout(7500),
      },
    );
    if (!res.ok) throw Error("speech_unavailable");
    const rows = (await res.json()) as Array<{
      ShortName: string;
      LocalName: string;
      Locale: string;
      StyleList?: string[];
    }>;
    return rows
      .filter(
        (v) =>
          ["zh-CN", "en-US"].includes(v.Locale) &&
          typeof v.ShortName === "string",
      )
      .map((v) => ({
        id: v.ShortName,
        name: v.LocalName,
        locale: v.Locale,
        styles: v.StyleList || [],
      }));
  })();
  catalog = { region, expires: Date.now() + 10 * 60_000, values };
  try {
    return await values;
  } catch {
    if (catalog?.values === values) catalog.expires = Date.now() + 10_000;
    throw Error("speech_unavailable");
  }
}
export function recognize(
  locale: string,
  hooks: {
    partial: (s: string) => void;
    final: (s: string) => void;
    failed: () => void;
  },
) {
  const { region, key } = credentials();
  const config = sdk.SpeechConfig.fromSubscription(key, region);
  config.speechRecognitionLanguage = locale;
  const stream = sdk.AudioInputStream.createPushStream(
    sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1),
  );
  const input = sdk.AudioConfig.fromStreamInput(stream);
  const speech = new sdk.SpeechRecognizer(config, input);
  let closed = false;
  speech.recognizing = (_, e) => {
    if (!closed && e.result.text) hooks.partial(e.result.text);
  };
  speech.recognized = (_, e) => {
    if (!closed) hooks.final(e.result.text || "");
  };
  speech.canceled = () => {
    if (!closed) hooks.failed();
  };
  speech.sessionStopped = () => {
    if (!closed) hooks.failed();
  };
  const ready = new Promise<void>((resolve, reject) =>
    speech.startContinuousRecognitionAsync(resolve, () =>
      reject(Error("recognition_failed")),
    ),
  );
  return {
    ready,
    write: (pcm: Uint8Array) => {
      if (!closed) stream.write(Uint8Array.from(pcm).buffer);
    },
    close: () => {
      if (closed) return;
      closed = true;
      stream.close();
      speech.close();
      input.close();
    },
  };
}

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&apos;",
  '"': "&quot;",
};
const escapeXml = (value: string) =>
  value.replace(/[&<>'"]/g, (c) => entities[c]);
type Expression = { rate: number; pauseMs: number; style?: string };

export async function* synthesize(
  text: string,
  voice: Voice,
  expression: Expression,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const { region, key } = credentials();
  const config = sdk.SpeechConfig.fromSubscription(key, region);
  config.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
  const synth = new sdk.SpeechSynthesizer(config, null);
  const queue: Uint8Array[] = [];
  let queued = 0;
  let done = false;
  let failed = false;
  let wake: (() => void) | undefined;
  const changed = () => {
    wake?.();
    wake = undefined;
  };
  const fail = () => {
    failed = true;
    changed();
  };
  const timer = setTimeout(fail, 30000);
  signal.addEventListener("abort", fail, { once: true });
  try {
    let body =
      '<prosody rate="' +
      Math.round((expression.rate - 1) * 100) +
      '%">' +
      escapeXml(text) +
      "</prosody>";
    if (expression.style && voice.styles.includes(expression.style))
      body =
        '<mstts:express-as style="' +
        escapeXml(expression.style) +
        '">' +
        body +
        "</mstts:express-as>";
    const ssml =
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="' +
      escapeXml(voice.locale) +
      '"><voice name="' +
      escapeXml(voice.id) +
      '">' +
      body +
      '<break time="' +
      expression.pauseMs +
      'ms"/></voice></speak>';
    synth.synthesizing = (_, event) => {
      if (failed || signal.aborted) return;
      const data = new Uint8Array(event.result.audioData);
      if (!data.length) return;
      queued += data.length;
      if (queued > 2_000_000 || data.length % 2) return fail();
      queue.push(data);
      changed();
    };
    synth.speakSsmlAsync(
      ssml,
      (result) => {
        if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted)
          return fail();
        done = true;
        changed();
      },
      fail,
    );
    while (true) {
      signal.throwIfAborted();
      if (failed) throw Error("synthesis_failed");
      const next = queue.shift();
      if (next) {
        queued -= next.length;
        for (let i = 0; i < next.length; i += 4800)
          yield next.subarray(i, i + 4800);
      } else if (done) break;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", fail);
    synth.close();
  }
}
