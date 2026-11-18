import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";

// Owns one ECharts instance: creates it once, keeps it sized to its container,
// applies the option on every change, and forwards point clicks by slug.
export function useChart(option: EChartsCoreOption, onSelect?: (slug: string) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chartRef.current = chart;
    chart.on("click", (params) => {
      const slug = (params.data as { slug?: string } | undefined)?.slug;
      if (slug) selectRef.current?.(slug);
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => chartRef.current?.setOption(preference.matches ? { ...option, animation: false } : option, { notMerge: true });
    apply();
    preference.addEventListener("change", apply);
    return () => preference.removeEventListener("change", apply);
  }, [option]);

  return ref;
}
