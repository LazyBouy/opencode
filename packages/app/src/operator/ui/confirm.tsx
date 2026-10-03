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
      const finish = (value: boolean) => {
        resolve(value)
        dialog.close()
      }
      void dialog.show(
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
        () => resolve(false),
      )
    })
}
