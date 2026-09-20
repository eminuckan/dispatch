import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function DispatchMark(props: {
  readonly size: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Dispatch"
      height={props.size}
      width={props.size}
      viewBox="-0.6810546875000001 -0.7513671875000001 81.291796875 81.432421875"
    >
      <ThemedPath
        d="m40.97 1.19h-27.1c-7 0-12.44 5.49-12.44 12.2v45.49c0 0.67 0.54 1.11 1.19 1.11h0.76c6.56 0 13 8.27 13 15.06 0 0.82-0.05 1.6-0.12 2.29-0.05 0.82 0.33 1.4 1.26 1.4h23.45c20.78 0 37.7-17.02 37.7-38.11 0-22.27-16.08-39.44-37.7-39.44z M47.83 31.59c-2.63-1.54-5.41-2.97-8.22-4.2-5.24-2-9.23-0.42-11.45 5.16-1.28 3.02-2.79 6.07-3.6 9.29-0.91 3.78 0.88 7.22 4.65 9.35 2.61 1.5 5.3 2.9 8.09 3.94 4.96 1.87 8.69 0.64 11.07-3.85 1.55-2.83 3.09-5.82 4.08-8.91 1.47-4.86 0.02-8.12-4.62-10.78z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
        fillRule="evenodd"
      />
      <Path
        d="m4.19 62.07c-1.98-0.19-2.93 1.32-2.93 3.51v2.66c0 6 4.06 9.85 9.29 10.25 2.4 0.12 3.91-1.33 3.86-3.78-0.14-5.3-5.46-12.25-10.22-12.64z"
        fill="#FF671B"
      />
    </Svg>
  );
}
