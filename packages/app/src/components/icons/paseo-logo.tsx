import { useCallback } from "react";
import Svg, { G, Path } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import glyph from "../../../assets/images/forkeo-glyph.json";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

const ThemedSvg = withUnistyles(Svg);

export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const colorMapping = useCallback(
    (theme: Theme) => ({ color: color ?? theme.colors.foreground }),
    [color],
  );
  return (
    <ThemedSvg
      width={size}
      height={size}
      viewBox={glyph.viewBox}
      fill="none"
      uniProps={colorMapping}
    >
      <G
        stroke="currentColor"
        strokeWidth={glyph.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {glyph.paths.map((d) => (
          <Path key={d} d={d} />
        ))}
      </G>
    </ThemedSvg>
  );
}
