import { useMemo } from "react";
import { View } from "react-native";
import { SvgCss } from "react-native-svg/css";

import { EmptyState } from "../../components/EmptyState";
import { svgAttachmentPreviewSource } from "./svgAttachmentPreviewSource";

function SvgPreviewError(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <EmptyState variant="plain" title={props.title} detail={props.detail} />
    </View>
  );
}

/** Native SVG parsing renders attachment markup without executing it as a web document. */
export function SvgAttachmentPreview(props: {
  readonly content: { readonly text: string; readonly truncated: boolean };
}) {
  const source = useMemo(() => svgAttachmentPreviewSource(props.content), [props.content]);
  if (source.status === "unavailable") return <SvgPreviewError {...source} />;

  return (
    <View className="flex-1 bg-sheet p-4">
      <SvgCss
        xml={source.xml}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        onError={() => undefined}
        fallback={
          <SvgPreviewError
            title="Could not render SVG"
            detail="This SVG uses markup the preview does not support. View its source or share it instead."
          />
        }
      />
    </View>
  );
}
