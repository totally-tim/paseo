import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentRequestUsage } from "@getpaseo/protocol/agent-types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountUsageTooltip } from "@/provider-accounts/usage-tooltip";
import { ProviderUsageTooltipSection } from "@/provider-usage/tooltip-section";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { Theme } from "@/styles/theme";
import { formatTokenCount } from "./context-window-meter.utils";

export interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  lastRequest?: AgentRequestUsage | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  serverId?: string;
  /** The Paseo provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  accountId?: string;
  model?: string | null;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

const ThemedCircle = withUnistyles(Circle);
const trackStroke = (theme: Theme) => ({ stroke: theme.colors.surface3 });
const normalStroke = (theme: Theme) => ({ stroke: theme.colors.foregroundMuted });
const warningStroke = (theme: Theme) => ({ stroke: theme.colors.palette.amber[500] });
const criticalStroke = (theme: Theme) => ({ stroke: theme.colors.destructive });

function progressStrokeFor(percentage: number) {
  if (percentage > 90) return criticalStroke;
  if (percentage >= 70) return warningStroke;
  return normalStroke;
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

function count(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function observedSpeed(
  output: number | null,
  firstToken: number | null,
  duration: number | null,
): number | null {
  // Approximate received-stream rate; a delta can contain several tokens.
  if (
    output === null ||
    output <= 1 ||
    firstToken === null ||
    duration === null ||
    duration <= firstToken
  )
    return null;
  return ((output - 1) * 1000) / (duration - firstToken);
}

function RequestMetrics({ lastRequest }: Pick<ContextWindowMeterProps, "lastRequest">) {
  const { t } = useTranslation();
  if (!lastRequest) return null;
  const request = lastRequest;
  const input = count(request.inputTokens);
  const cached = count(request.cachedInputTokens);
  const output = count(request.outputTokens);
  const reasoning = count(request.reasoningTokens);
  const firstToken = count(request.firstTokenMs);
  const duration = count(request.durationMs);
  const validCache = input !== null && cached !== null && cached <= input;
  const cacheHit = validCache && input > 0 ? (100 * cached) / input : null;
  const speed = observedSpeed(output, firstToken, duration);

  let cacheText = t("contextWindow.cacheNotReported");
  if (cached !== null)
    cacheText = t("contextWindow.cachedInput", { tokens: cached.toLocaleString() });
  if (cacheHit !== null && cached !== null)
    cacheText = t("contextWindow.cacheHit", {
      tokens: cached.toLocaleString(),
      percentage: cacheHit.toLocaleString(undefined, { maximumFractionDigits: 1 }),
    });
  return (
    <>
      <Text style={styles.tooltipTitle}>{t("contextWindow.lastRequest")}</Text>
      {input !== null ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.input", { tokens: input.toLocaleString() })}
        </Text>
      ) : null}
      <Text style={styles.tooltipDetail}>{cacheText}</Text>
      {validCache ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.uncachedInput", { tokens: (input - cached).toLocaleString() })}
        </Text>
      ) : null}
      {output !== null ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.output", { tokens: output.toLocaleString() })}
        </Text>
      ) : null}
      {reasoning !== null && (output === null || reasoning <= output) ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.reasoning", { tokens: reasoning.toLocaleString() })}
        </Text>
      ) : null}
      {firstToken !== null ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.firstToken", {
            seconds: (firstToken / 1000).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            }),
          })}
        </Text>
      ) : null}
      {speed !== null ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.generationSpeed", {
            speed: speed.toLocaleString(undefined, { maximumFractionDigits: 1 }),
          })}
        </Text>
      ) : null}
      {speed !== null ? (
        <Text style={styles.tooltipDetail}>{t("contextWindow.generationHint")}</Text>
      ) : null}
    </>
  );
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  lastRequest,
  totalCostUsd,
  showPercentage = false,
  serverId,
  provider,
  accountId,
  model,
  pending = false,
  glyphSize,
}: ContextWindowMeterProps) {
  const { t } = useTranslation();
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);
  const { view: providerUsageView, refresh: refreshProviderUsage } = useProviderUsage(
    serverId ?? null,
    { enabled: isTooltipOpen && !accountId },
  );
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;
  const handleTooltipOpenChange = useCallback(
    (nextOpen: boolean) => {
      setIsTooltipOpen(nextOpen);
      if (nextOpen && !accountId) {
        void refreshProviderUsage().catch(() => {});
      }
    },
    [refreshProviderUsage, accountId],
  );

  const geometry = getMeterGeometry(showPercentage, glyphSize);

  const clampedPercentage = clampPercentage(percentage ?? 0);
  const roundedPercentage = Math.round(percentage ?? 0);
  const { svgSize, center, radius, strokeWidth, circumference, containerStyle } = geometry;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;
  const progressStroke = progressStrokeFor(clampedPercentage);

  return (
    <Tooltip
      open={isTooltipOpen}
      onOpenChange={handleTooltipOpenChange}
      delayDuration={0}
      enabledOnDesktop
      enabledOnMobile
    >
      <TooltipTrigger asChild triggerRefProp="ref">
        <Pressable
          style={containerStyle}
          testID="context-window-meter"
          accessibilityRole="button"
          accessibilityLabel={
            percentage === null
              ? t("contextWindow.title")
              : t("contextWindow.accessibility", { percentage: roundedPercentage })
          }
        >
          <Svg
            width={svgSize}
            height={svgSize}
            viewBox={`0 0 ${svgSize} ${svgSize}`}
            style={styles.svg}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <ThemedCircle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              uniProps={percentage === null ? normalStroke : trackStroke}
              strokeWidth={strokeWidth}
            />
            <ThemedCircle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              uniProps={progressStroke}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          </Svg>
          {showPercentage ? (
            <Text style={styles.percentageLabel}>
              {percentage === null ? "—" : `${roundedPercentage}%`}
            </Text>
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <View style={styles.tooltipContent}>
          <ContextUsageDetails
            percentage={percentage}
            maxTokens={maxTokens}
            usedTokens={usedTokens}
            pending={pending}
            totalCostUsd={totalCostUsd}
          />
          {accountId && serverId && isTooltipOpen ? (
            <AccountUsageTooltip
              serverId={serverId}
              accountId={accountId}
              provider={provider}
              model={model}
            />
          ) : null}
          {!accountId ? (
            <ProviderUsageTooltipSection view={providerUsageView} activeProviderId={provider} />
          ) : null}
          <RequestMetrics lastRequest={lastRequest} />
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

function ContextUsageDetails({
  percentage,
  maxTokens,
  usedTokens,
  pending,
  totalCostUsd,
}: Pick<ContextWindowMeterProps, "maxTokens" | "usedTokens" | "pending" | "totalCostUsd"> & {
  percentage: number | null;
}) {
  const { t } = useTranslation();
  const roundedPercentage = Math.round(percentage ?? 0);
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;
  return (
    <>
      <Text style={styles.tooltipTitle}>{t("contextWindow.title")}</Text>
      <Text style={styles.tooltipText}>
        {percentage === null
          ? t(pending ? "common.loading" : "providerAccounts.contextUnavailable")
          : t("contextWindow.used", { percentage: roundedPercentage })}
      </Text>
      {percentage !== null && usedTokens !== null && maxTokens !== null ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.tokens", {
            used: formatTokenCount(usedTokens),
            max: formatTokenCount(maxTokens),
          })}
        </Text>
      ) : null}
      {formattedSessionCost ? (
        <Text style={styles.tooltipDetail}>
          {t("contextWindow.sessionCost", { cost: formattedSessionCost })}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipContent: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
}));
