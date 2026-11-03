import { useComposer } from '@get-bb/plugin-sdk/app';
import { COMPANY_FOLDER_PROMPT } from './folder-contract';
import { CompanyFolderGuidance } from './ChooseCompanyFolder';

/** Show guidance only beside the prepared handoff, never in unrelated chats. */
export function FolderComposerBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== 'new-thread' || composer.text !== COMPANY_FOLDER_PROMPT) return null;
  return <CompanyFolderGuidance />;
}
