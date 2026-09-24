import { useId, useRef, useState, useTransition } from "react";

import { sanitizeNewRefName } from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function NewBranchDialog({
  initialName,
  onCreate,
  onClose,
}: {
  initialName: string;
  onCreate: (name: string) => Promise<string | null>;
  onClose: () => void;
}) {
  // This is an opening-time seed. Settings refreshes must not rewrite an edit.
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const hasFocused = useRef(false);
  const refName = sanitizeNewRefName(name);
  const canCreate = refName.length > 0 && !refName.endsWith("/");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup showCloseButton={!pending} initialFocus={inputRef}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canCreate || pending) return;
            setError(null);
            startTransition(async () => {
              try {
                const failure = await onCreate(refName);
                if (failure === null) onClose();
                else setError(failure);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Could not create the branch.");
              }
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>
              Create and switch to a branch in the current workspace.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label htmlFor={inputId} className="mb-2 block text-sm">
              Branch name
            </label>
            <Input
              ref={inputRef}
              id={inputId}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              onFocus={(event) => {
                if (hasFocused.current) return;
                hasFocused.current = true;
                event.target.setSelectionRange(name.length, name.length);
              }}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono"
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
              disabled={pending}
            />
            {error ? (
              <p id={errorId} role="alert" className="mt-2 text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate || pending}>
              {pending ? "Creating…" : "Create branch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
