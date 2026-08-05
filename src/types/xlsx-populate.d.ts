declare module 'xlsx-populate' {
  interface ChartOptions {
    title?: string;
    xAxis?: {
      title?: string;
      titleFontSize?: number;
      labelFontSize?: number;
    };
    yAxis?: {
      title?: string;
      titleFontSize?: number;
      labelFontSize?: number;
    };
    width?: number;
    height?: number;
    series?: Array<{
      name?: string;
      xValues: string;
      yValues: string;
      marker?: { symbol?: string };
      line?: { width?: number; color?: string };
    }>;
  }

  interface Chart {
    style(styleId: number): Chart;
  }

  interface Cell {
    value(value: string | number | null | undefined): Cell;
  }

  interface Column {
    width(width: number): Column;
  }

  interface Sheet {
    name(name: string): Sheet;
    cell(ref: string): Cell;
    cell(row: number, col: number): Cell;
    column(ref: string): Column;
    chart(type: 'scatter' | 'line' | 'bar' | 'pie' | 'area', position: string, options: ChartOptions): Chart;
  }

  interface Workbook {
    addSheet(name: string): Sheet;
    deleteSheet(name: string): void;
    sheet(index: number): Sheet;
    outputAsync(): Promise<Blob>;
  }

  interface XlsxPopulateStatic {
    fromBlankAsync(): Promise<Workbook>;
    fromFileAsync(path: string): Promise<Workbook>;
    fromDataAsync(data: ArrayBuffer | Buffer): Promise<Workbook>;
  }

  const XlsxPopulate: XlsxPopulateStatic;
  export default XlsxPopulate;
}
