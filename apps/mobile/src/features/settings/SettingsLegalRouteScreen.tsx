import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  return (
    <SettingsLegalDocumentRouteScreen
      documentName="Upstream T3 Code legal reference"
      documentUrl={LEGAL_URL}
    />
  );
}
