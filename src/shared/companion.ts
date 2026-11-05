export type Companion = {
  id: string;
  name: string;
  persona: string;
  locale: string;
  voice: string;
};
export type CompanionInput = Omit<Companion, "id">;
