declare module "echarts-for-react" {
  import type { CSSProperties, HTMLAttributes } from "react";
  import type { Component } from "react";
  import type { EChartsType } from "echarts";

  export interface ReactEChartsProps extends HTMLAttributes<HTMLDivElement> {
    option: Record<string, unknown>;
    style?: CSSProperties;
    theme?: string | Record<string, unknown>;
    opts?: {
      renderer?: "canvas" | "svg";
      width?: number | "auto" | null;
      height?: number | "auto" | null;
    };
    notMerge?: boolean;
    replaceMerge?: string | string[] | null;
    lazyUpdate?: boolean;
    showLoading?: boolean;
    loadingOption?: Record<string, unknown> | null;
    onChartReady?: (instance: EChartsType) => void;
    onEvents?: Record<string, (...args: unknown[]) => void>;
    autoResize?: boolean;
    shouldSetOption?: (
      prevProps: ReactEChartsProps,
      props: ReactEChartsProps,
    ) => boolean;
  }

  export default class ReactEcharts extends Component<ReactEChartsProps> {
    getEchartsInstance(): EChartsType;
  }
}
