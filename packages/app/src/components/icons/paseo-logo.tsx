import Svg, { G, Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";

interface PaseoLogoProps {
  size?: number;
  color?: string;
}

export function PaseoLogo({ size = 64, color }: PaseoLogoProps) {
  const { theme } = useUnistyles();
  const stroke = color ?? theme.colors.foreground;

  return (
    <Svg width={size} height={size} viewBox="0 0 700 700" fill="none">
      <G
        stroke={stroke}
        strokeWidth={58}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(350 355) rotate(-13) scale(1.28) translate(-350 -350)"
      >
        <Path d="M 330 600 C 268 582, 236 528, 250 474 C 262 432, 302 414, 334 430 C 360 443, 370 474, 360 504" />
        <Path d="M 355 505 C 350 470, 346 440, 342 405 C 300 380, 250 330, 238 268 C 228 215, 244 168, 285 142" />
        <Path d="M 342 405 C 395 378, 462 328, 492 262 C 515 212, 540 175, 522 142" />
      </G>
    </Svg>
  );
}
