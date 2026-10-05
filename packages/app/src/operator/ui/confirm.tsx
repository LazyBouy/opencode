import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
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
