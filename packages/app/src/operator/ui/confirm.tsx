import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export interface ConfirmInput {
  readonly title: string
  readonly description: string
  readonly confirm: string
  readonly danger?: boolean
}

// Asks the user to confirm an action; resolves false when they cancel or dismiss the dialog.
export function useConfirm() {
  const dialog = useDialog()
  const language = useLanguage()
  return (input: ConfirmInput) =>
    new Promise<boolean>((resolve) => {
      // Answered once the question has closed (dialogs close over 100ms), so what follows can open
      // or close dialogs, such as the overlay it was asked over. Closing it any other way is a no.
      let answer = false
      const finish = (value: boolean) => {
        answer = value
        dialog.close()
      }
      const closed = () => setTimeout(() => resolve(answer), 120)
      // Over an open dialog (a record's overlay) the question stacks on it, so the overlay stays.
      const open = dialog.active ? dialog.push : dialog.show
      void open(
        () => (
          <Dialog fit>
            <DialogHeader hideClose={true}>
              <DialogTitle>{input.title}</DialogTitle>
            </DialogHeader>
            <DialogBody class="px-4 pt-2 pb-2 text-13-regular text-v2-text-text-muted">{input.description}</DialogBody>
            <DialogFooter>
              <ButtonV2 variant="neutral" onClick={() => finish(false)}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant={input.danger ? "danger" : "contrast"} onClick={() => finish(true)} autofocus>
                {input.confirm}
              </ButtonV2>
            </DialogFooter>
          </Dialog>
        ),
        closed,
      )
    })
}

// Every delete moves the item to Trash, after asking. `run` does the move.
export function useMoveToTrash() {
  const confirm = useConfirm()
  const language = useLanguage()
  return async (name: string, run: () => Promise<unknown>) => {
    const ok = await confirm({
      title: language.t("operator.trash.moveTitle", { name }),
      description: language.t("operator.trash.moveBody"),
      confirm: language.t("operator.trash.moveConfirm"),
      danger: true,
    })
    if (ok) await run()
    return ok
  }
}

// Deleting for good (from Trash) cannot be undone, and says so.
export function useDeleteForGood() {
  const confirm = useConfirm()
  const language = useLanguage()
  return async (name: string, run: () => Promise<unknown>) => {
    const ok = await confirm({
      title: language.t("operator.trash.purgeTitle", { name }),
      description: language.t("operator.trash.purgeBody"),
      confirm: language.t("operator.trash.purgeConfirm"),
      danger: true,
    })
    if (ok) await run()
    return ok
  }
}

export interface AskTextInput {
  readonly title: string
  readonly label: string
  readonly value?: string
  readonly confirm: string
  /** Also ask for a description, with this label. */
  readonly description?: { readonly label: string; readonly value?: string }
}

// Asks for a name (and a description); resolves undefined when they cancel or dismiss the dialog, or leave it empty.
export function useAskText() {
  const dialog = useDialog()
  const language = useLanguage()
  return (input: AskTextInput) =>
    new Promise<{ name: string; description: string } | undefined>((resolve) => {
      let answer: { name: string; description: string } | undefined
      const [name, setName] = createSignal(input.value ?? "")
      const [description, setDescription] = createSignal(input.description?.value ?? "")
      const finish = (ok: boolean) => {
        answer = ok && name().trim() ? { name: name().trim(), description: description().trim() } : undefined
        dialog.close()
      }
      const closed = () => setTimeout(() => resolve(answer), 120)
      const open = dialog.active ? dialog.push : dialog.show
      void open(
        () => (
          <Dialog fit>
            <DialogHeader hideClose={true}>
              <DialogTitle>{input.title}</DialogTitle>
            </DialogHeader>
            <DialogBody class="flex flex-col gap-3 px-4 pt-2 pb-2">
              <label class="flex flex-col gap-1 text-13-regular">
                <span>{input.label}</span>
                <TextInputV2
                  appearance="base"
                  value={name()}
                  autofocus
                  onInput={(event) => setName(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") finish(true)
                  }}
                />
              </label>
              <Show when={input.description}>
                {(field) => (
                  <label class="flex flex-col gap-1 text-13-regular">
                    <span>{field().label}</span>
                    <TextareaV2
                      rows={2}
                      value={description()}
                      onInput={(event) => setDescription(event.currentTarget.value)}
                    />
                  </label>
                )}
              </Show>
            </DialogBody>
            <DialogFooter>
              <ButtonV2 variant="neutral" onClick={() => finish(false)}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2 variant="contrast" disabled={!name().trim()} onClick={() => finish(true)}>
                {input.confirm}
              </ButtonV2>
            </DialogFooter>
          </Dialog>
        ),
        closed,
      )
    })
}
