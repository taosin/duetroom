import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export function RoomDialog({
  title,
  closeLabel,
  onClose,
  children,
  className,
  busy = false,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  busy?: boolean;
}) {
  const opener = useRef(document.activeElement);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className={className}
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (
            opener.current instanceof HTMLElement &&
            opener.current.isConnected
          ) {
            opener.current.focus();
          }
        }}
      >
        <header className="topline">
          <DialogTitle>{title}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            disabled={busy}
            aria-label={closeLabel}
          >
            <X aria-hidden="true" />
          </Button>
        </header>
        {children}
      </DialogContent>
    </Dialog>
  );
}
