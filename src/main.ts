import { Chart, registerables } from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import 'hammerjs';
import html2canvas from 'html2canvas';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import {
  calculateDifferential,
  calculateDqdi,
  calculateDqdiFromCurrentCapacity,
  calculateDqdiRobust,
  calculateDirectDifferential,
  validateData,
  calculateR2,
  defaultFittingParams,
  defaultSeparateDiffParams,
  defaultDqdiParams,
  defaultDirectDiffParams,
  defaultDiffCurveFittingParams,
  FittingMethod,
  FittingParams,
  DifferentialParams,
  DifferentialMethod,
  SeparateDiffParams,
  DifferentialResult,
  DqdiResult,
  DirectDiffParams,
  DiffCurveFittingParams,
  DirectDiffResult,
  performFitting,
  FittingResult,
} from './utils/calculations';
import {
  detectPeaks,
  formatPeaksTable,
  exportPeaksCSV,
  defaultPeakParams,
  Peak,
  PeakDetectionParams,
  calculatePeakDistances,
  calculatePeakIntervals,
} from './utils/peakDetection';
import {
  calculateCVCharacteristics,
  CVCharacteristics,
} from './utils/cvCharacteristics';

Chart.register(...registerables, zoomPlugin);

// 通用 zoom 配置（局部放大功能）
function getZoomOptions() {
  return {
    zoom: {
      wheel: { enabled: true },
      pinch: { enabled: true },
      mode: 'x' as const,
    },
    pan: {
      enabled: true,
      mode: 'x' as const,
    },
  };
}

// 生成横坐标范围编辑 HTML
function createXAxisEditor(chartId: string, label: string): string {
  return `
    <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
      <span class="text-gray-600 font-medium">${label}范围:</span>
      <input type="number" id="${chartId}XMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
      <span class="text-gray-400">~</span>
      <input type="number" id="${chartId}XMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
      <button id="${chartId}XApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
      <button id="${chartId}XReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
    </div>
  `;
}

// 应用横坐标范围设置
function applyXAxisRange(chartId: string, chart: Chart | null): void {
  if (!chart || !chart.options.scales || !chart.options.scales.x) return;
  const minInput = document.getElementById(`${chartId}XMin`) as HTMLInputElement;
  const maxInput = document.getElementById(`${chartId}XMax`) as HTMLInputElement;
  const min = parseFloat(minInput?.value);
  const max = parseFloat(maxInput?.value);
  
  if (!isNaN(min) && !isNaN(max) && min < max) {
    (chart.options.scales.x as any).min = min;
    (chart.options.scales.x as any).max = max;
    chart.update('none');
  }
}

// 重置横坐标范围
function resetXAxisRange(chartId: string, chart: Chart | null): void {
  if (!chart || !chart.options.scales || !chart.options.scales.x) return;
  const minInput = document.getElementById(`${chartId}XMin`) as HTMLInputElement;
  const maxInput = document.getElementById(`${chartId}XMax`) as HTMLInputElement;
  if (minInput) minInput.value = '';
  if (maxInput) maxInput.value = '';
  
  // 删除 min/max 设置，让 Chart.js 自动计算
  delete (chart.options.scales.x as any).min;
  delete (chart.options.scales.x as any).max;
  chart.update('none');
}

// 数据类型枚举
type DataType = 'discharge' | 'charge';

// 充电模式类型
type ChargeMode = 'cc' | 'cv' | 'cccv';

// 恒压充电数据列类型
type CVColumnType = 'current-capacity' | 'current-time';

// 恒流恒压充电数据列类型
type CCCVColumnType = 'current-voltage-capacity' | 'current-voltage-time';

// 充电阶段类型
type ChargePhase = 'cc' | 'cv' | 'mixed';

// 单个数据集
type DiffMode = 'fitted' | 'direct'; // 差分模式：fitted=拟合后差分，direct=直接差分

interface Dataset {
  id: string;
  name: string;
  dataType: DataType;  // 数据类型：放电或充电
  chargePhase?: ChargePhase;  // 充电阶段类型（仅充电数据有效）
  chargeMode?: ChargeMode;  // 充电模式：CC、CV、CCCV
  voltage: number[];
  capacity: number[];
  // 恒压充电数据（用于 dQ/dI 分析）
  current?: number[];   // 电流数组
  time?: number[];      // 时间数组 (s)
  // CV模式专用
  cvColumnType?: CVColumnType;  // CV模式数据列类型
  // CC/CV 阶段分离后的数据
  ccData?: {
    voltage: number[];
    capacity: number[];
    startIndex: number;
    endIndex: number;
  };
  cvData?: {
    voltage: number[];
    capacity: number[];
    current: number[];
    time: number[];
    startIndex: number;
    endIndex: number;
  };
  color: string; // 显示颜色
  visible: boolean; // 是否在图表中显示
  fitting: FittingResult | null; // 独立的拟合结果
  differential: {
    voltage: number[];
    capacity: number[];
    fittedVoltage: number[];
    fittedCapacity: number[];
    uniformVoltage: number[];  // 均匀电压网格
    uniformCapacity: number[]; // 均匀容量网格
    dqdv: number[];
    dvdq: number[];
    dsocdv: number[];  // dSOC/dV
    maxCapacity: number;  // 最大容量（用于SOC归一化）
    dqdvVoltage?: number[];  // dQ/dV曲线的独立电压点（改进方法）
    dvdqCapacity?: number[]; // dV/dQ曲线的独立容量点（改进方法）
    // 新增曲线数据
    soc: number[];  // SOC 数组
    dqdvQ: number[];       // dQ/dV vs Q
    dqdvCapacity: number[];
    dqdvSoc: number[];     // dQ/dV vs SOC
    dqdvSocX: number[];
    dvdqV: number[];       // dV/dQ vs V
    dvdqVoltage: number[];
    dvdqSoc: number[];     // dV/dQ vs SOC
    dvdqSocX: number[];
    dsocdvQ: number[];       // dSOC/dV vs Q
    dsocdvCapacity: number[];
    dsocdvSoc: number[];     // dSOC/dV vs SOC
    dsocdvSocX: number[];
    // V vs SOC（充放电曲线）
    vSoc: number[];          // 电压数组
    vSocX: number[];         // SOC 数组
  } | null;
  // 直接差分结果（不对原始数据拟合，直接差分后拟合差分曲线）
  directDifferential: {
    // 原始数据的差分结果
    rawDqdv: { voltage: number[]; dqdv: number[] } | null;
    rawDvdq: { capacity: number[]; dvdq: number[] } | null;
    // 对差分曲线拟合后的结果
    fittedDqdv: { voltage: number[]; dqdv: number[]; dqdvSmoothed: number[] } | null;
    fittedDvdq: { capacity: number[]; dvdq: number[]; dvdqSmoothed: number[] } | null;
    // dSOC/dV（归一化的dQ/dV）
    dsocdv: number[];
    maxCapacity: number;
    // dQ/dV vs Q
    dqdvQ: number[];
    dqdvCapacity: number[];
    // dQ/dV vs SOC
    dqdvSoc: number[];
    dqdvSocX: number[];
    // dV/dQ vs V
    dvdqV: number[];
    dvdqVoltage: number[];
    // dV/dQ vs SOC
    dvdqSoc: number[];
    dvdqSocX: number[];
    // dSOC/dV vs Q
    dsocdvQ: number[];
    dsocdvCapacity: number[];
    // dSOC/dV vs SOC
    dsocdvSoc: number[];
    dsocdvSocX: number[];
    // V vs SOC（充放电曲线）
    vSoc: number[];          // 电压数组
    vSocX: number[];         // SOC 数组
  } | null;
  // dQ/dI 分析结果（恒压充电模式）
  dqdi: DqdiResult | null;
  peaks: { dqdv: Peak[]; dvdq: Peak[]; dsocdv: Peak[]; dqdi: Peak[] };
  r2Score: { voltageToCapacity: number; capacityToVoltage: number } | null;
  // 编辑功能相关
  editedRanges: EditedRange[]; // 被编辑的区域列表
  originalData: { voltage: number[]; capacity: number[] } | null; // 原始数据备份（包含电流用于CC-CV模式）
}

// 编辑区域定义
interface EditedRange {
  id: string;
  chartType: 'raw' | 'dqdv' | 'dvdq'; // 所属图表类型
  startIndex: number;
  endIndex: number;
  action: 'deleted' | 'colored'; // 操作类型
  color?: string; // 标注颜色
  xStart: number; // X轴起始值
  xEnd: number; // X轴结束值
  yStart?: number; // Y轴起始值（矩形框选）
  yEnd?: number; // Y轴结束值（矩形框选）
}

// 分开的峰检测参数
interface SeparatePeakParams {
  dqdv: PeakDetectionParams & { enabled: boolean };
  dvdq: PeakDetectionParams & { enabled: boolean };
  dqdi: PeakDetectionParams & { enabled: boolean };
}

interface AppState {
  currentDataType: DataType;  // 当前数据类型
  chargeMode: ChargeMode;  // 充电模式：CC、CV、CCCV
  cvColumnType: CVColumnType;  // CV模式数据列类型
  cccvColumnType: CCCVColumnType;  // CCCV模式数据列类型
  datasets: Dataset[]; // 多数据集
  activeDatasetId: string | null; // 当前激活的数据集
  fittingParams: FittingParams;
  diffParams: SeparateDiffParams;
  dqdiParams: DifferentialParams; // dQ/dI 参数
  peakParams: SeparatePeakParams;
  diffMode: DiffMode; // 差分模式：fitted=拟合后差分，direct=直接差分
  directDiffParams: DirectDiffParams; // 直接差分参数
  diffCurveFittingParams: DiffCurveFittingParams; // 差分曲线拟合参数
  charts: { 
    raw: Chart | null; 
    dqdv: Chart | null; 
    dvdq: Chart | null; 
    dsocdv: Chart | null;
    // 新增曲线图表
    dqdvQ: Chart | null;      // dQ/dV vs Q
    dqdvSoc: Chart | null;    // dQ/dV vs SOC
    dvdqV: Chart | null;      // dV/dQ vs V
    dvdqSoc: Chart | null;    // dV/dQ vs SOC
    dsocdvQ: Chart | null;    // dSOC/dV vs Q
    dsocdvSoc: Chart | null;  // dSOC/dV vs SOC
    // V vs SOC（充放电曲线）
    vSoc: Chart | null;        // 电压 vs SOC
    // dQ/dI 分析图表
    dqdi: Chart | null;       // dQ/dI vs I
    didq: Chart | null;       // dI/dQ vs Q
    currentCapacity: Chart | null; // I-Q 曲线
  };
  // 框选编辑状态
  selection: {
    chartType: 'raw' | 'dqdv' | 'dvdq' | null;
    xStart: number | null;
    xEnd: number | null;
    yStart: number | null;
    yEnd: number | null;
    isSelecting: boolean;
  };
  editMode: boolean; // 是否开启编辑模式
  pointDeleteMode: boolean; // 是否开启点选删除模式
}

// 预设颜色
const DATASET_COLORS = [
  'rgb(59, 130, 246)',   // 蓝
  'rgb(239, 68, 68)',   // 红
  'rgb(16, 185, 129)',  // 绿
  'rgb(139, 92, 246)',  // 紫
  'rgb(245, 158, 11)',  // 橙
  'rgb(236, 72, 153)',  // 粉
  'rgb(20, 184, 166)',  // 青
  'rgb(99, 102, 241)',  // 靛蓝
];

const defaultSeparatePeakParams = (): SeparatePeakParams => ({
  dqdv: { ...defaultPeakParams(), enabled: true },
  dvdq: { ...defaultPeakParams(), enabled: true },
  dqdi: { ...defaultPeakParams(), enabled: true },
});

const generateId = () => `ds_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const state: AppState = {
  currentDataType: 'discharge',  // 默认放电数据
  chargeMode: 'cc',  // 默认恒流充电
  cvColumnType: 'current-capacity',  // 默认电流-容量
  cccvColumnType: 'current-voltage-capacity',  // 默认电流-电压-容量
  datasets: [],
  activeDatasetId: null,
  fittingParams: { ...defaultFittingParams },
  diffParams: defaultSeparateDiffParams(),
  dqdiParams: defaultDqdiParams(),
  peakParams: defaultSeparatePeakParams(),
  diffMode: 'fitted', // 默认使用拟合后差分
  directDiffParams: defaultDirectDiffParams(),
  diffCurveFittingParams: defaultDiffCurveFittingParams(),
  charts: { 
    raw: null, 
    dqdv: null, 
    dvdq: null, 
    dsocdv: null,
    dqdvQ: null,
    dqdvSoc: null,
    dvdqV: null,
    dvdqSoc: null,
    dsocdvQ: null,
    dsocdvSoc: null,
    vSoc: null,
    dqdi: null,
    didq: null,
    currentCapacity: null,
  },
  selection: {
    chartType: null,
    xStart: null,
    xEnd: null,
    yStart: null,
    yEnd: null,
    isSelecting: false,
  },
  editMode: false,
  pointDeleteMode: false,
};

// 获取当前激活的数据集
function getActiveDataset(): Dataset | null {
  return state.datasets.find(ds => ds.id === state.activeDatasetId) || null;
}

// 获取下一个可用颜色
function getNextColor(): string {
  return DATASET_COLORS[state.datasets.length % DATASET_COLORS.length];
}

export function initApp(): void {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-3 md:p-4">
      <div class="max-w-7xl mx-auto">
        <div class="text-center mb-3">
          <h1 class="text-2xl font-bold text-gray-800">电化学差分分析工具</h1>
          <p class="text-gray-500 text-xs">dQ/dV、dV/dQ 与 dQ/dI 综合分析 + 峰识别</p>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-4 gap-3">
          <!-- 左侧控制面板 -->
          <div class="lg:col-span-1 space-y-2">
            <!-- 数据类型选择 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <h2 class="text-xs font-semibold text-gray-800 mb-1">📊 数据类型</h2>
              <div class="flex gap-1">
                <button id="dataTypeDischarge" class="flex-1 py-1 px-2 rounded text-xs font-medium bg-blue-500 text-white">放电数据</button>
                <button id="dataTypeCharge" class="flex-1 py-1 px-2 rounded text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200">充电数据</button>
              </div>
              <p id="dataTypeHint" class="text-xs text-gray-400 mt-1">放电数据: dQ/dV、dV/dQ 分析 (支持多数据集)</p>
              
              <!-- 充电模式选项（仅充电数据时显示） -->
              <div id="chargeModeOptions" class="hidden mt-2 pt-2 border-t border-gray-200">
                <h3 class="text-xs font-semibold text-gray-700 mb-1">充电模式</h3>
                <div class="flex gap-1 mb-2">
                  <button id="chargeModeCC" class="flex-1 py-1 px-2 rounded text-xs font-medium bg-orange-500 text-white" title="恒流充电">恒流(CC)</button>
                  <button id="chargeModeCV" class="flex-1 py-1 px-2 rounded text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200" title="恒压充电">恒压(CV)</button>
                  <button id="chargeModeCCCV" class="flex-1 py-1 px-2 rounded text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200" title="恒流恒压充电">CC-CV</button>
                </div>
                
                <!-- 恒流充电说明 -->
                <div id="ccModeHint" class="text-xs text-gray-500 bg-orange-50 p-1 rounded">
                  恒流充电：输入2列数据（电压、容量）
                </div>
                
                <!-- 恒压充电数据列类型选择 -->
                <div id="cvModeOptions" class="hidden">
                  <label class="text-xs text-gray-600">数据列类型：</label>
                  <select id="cvColumnType" class="w-full px-2 py-1 border border-gray-300 rounded text-xs mt-1">
                    <option value="current-capacity">电流 - 容量</option>
                    <option value="current-time">电流 - 时间</option>
                  </select>
                  <p class="text-xs text-gray-500 mt-1">恒压充电：输入2列数据</p>
                </div>
                
                <!-- 恒流恒压充电数据列类型选择 -->
                <div id="cccvModeOptions" class="hidden">
                  <label class="text-xs text-gray-600">数据列类型：</label>
                  <select id="cccvColumnType" class="w-full px-2 py-1 border border-gray-300 rounded text-xs mt-1">
                    <option value="current-voltage-capacity">电流 - 电压 - 容量</option>
                    <option value="current-voltage-time">电流 - 电压 - 时间</option>
                  </select>
                  <p class="text-xs text-gray-500 mt-1">CC-CV充电：输入3列数据，自动区分恒流/恒压段</p>
                </div>
              </div>
            </div>
            
            <!-- 数据输入与管理 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <h2 class="text-xs font-semibold text-gray-800 mb-1">📋 数据集管理</h2>
              <textarea id="dataInput" class="w-full h-32 px-2 py-1 border border-gray-300 rounded text-xs font-mono resize-none" placeholder="支持横向/纵向格式粘贴数据：&#10;&#10;【横向格式】每2列或3列为一个数据集，从Excel直接复制&#10;  数据集1		数据集2&#10;  电压	容量	电压	容量&#10;  4.0	0.01	4.0	0.02&#10;&#10;【纵向格式】每行一组数据，用 #名称 分隔多个数据集&#10;  # 样品1&#10;  3.0,0.001&#10;  3.1,0.002"></textarea>
              <div class="flex gap-1 mt-1">
                <button id="loadSampleData" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 py-0.5 px-1 rounded text-xs">示例</button>
                <button id="addDataset" class="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-0.5 px-1 rounded text-xs font-medium">+ 添加数据集</button>
                <button id="clearAllData" class="bg-red-100 hover:bg-red-200 text-red-600 py-0.5 px-1 rounded text-xs">清空</button>
              </div>
              <!-- 批量导入 -->
              <div class="mt-1">
                <label class="flex items-center justify-center gap-1 bg-green-500 hover:bg-green-600 text-white py-0.5 px-2 rounded text-xs cursor-pointer">
                  <span>📁 批量导入文件</span>
                  <input type="file" id="batchImportFiles" class="hidden" multiple accept=".csv,.txt,.xlsx,.xls">
                </label>
                <p class="text-xs text-gray-400 mt-0.5 text-center">支持 CSV/TXT/XLSX，可多选</p>
              </div>
              <!-- 批量粘贴 -->
              <div class="mt-1">
                <button id="openBatchPasteModal" class="w-full bg-purple-500 hover:bg-purple-600 text-white py-0.5 px-2 rounded text-xs">
                  📋 批量粘贴数据集
                </button>
                <p class="text-xs text-gray-400 mt-0.5 text-center">一次性粘贴多个数据集</p>
              </div>
              <div id="dataInfo" class="hidden text-xs mt-1"></div>
              
              <!-- 全选控制 -->
              <div id="selectAllControl" class="hidden mt-2 flex items-center justify-between px-1 py-1 bg-gray-50 rounded">
                <label class="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" id="selectAllDatasets" class="w-3 h-3 accent-blue-500 cursor-pointer">
                  <span class="text-xs text-gray-600">全选</span>
                </label>
                <span id="datasetCount" class="text-xs text-gray-500"></span>
              </div>
              
              <!-- 数据集列表 -->
              <div id="datasetList" class="mt-2 space-y-1 max-h-28 overflow-y-auto">
                <div class="text-xs text-gray-400 text-center py-1">点击"添加数据集"导入数据</div>
              </div>
              
              <!-- 汇总导出按钮 -->
              <button id="exportAllDatasets" class="w-full mt-2 bg-indigo-500 hover:bg-indigo-600 text-white font-medium py-1 rounded text-xs disabled:opacity-50" disabled>
                📊 汇总导出全部数据集
              </button>
            </div>

            <!-- 拟合与差分模式 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <h2 class="text-xs font-semibold text-gray-800 mb-1">📈 拟合与差分模式</h2>
              <!-- 差分模式选择 -->
              <div class="mb-2">
                <label class="text-xs text-gray-600">差分模式</label>
                <div class="flex gap-1 mt-1">
                  <button id="diffModeFitted" class="flex-1 py-1 px-2 rounded text-xs font-medium bg-blue-500 text-white" title="先拟合原始数据，再对拟合曲线求导">拟合后差分</button>
                  <button id="diffModeDirect" class="flex-1 py-1 px-2 rounded text-xs font-medium bg-gray-100 text-gray-600 hover:bg-gray-200" title="直接对原始数据求导，再拟合差分曲线">直接差分</button>
                </div>
                <p id="diffModeHint" class="text-xs text-gray-400 mt-1">拟合后差分：先拟合曲线，再求导</p>
              </div>
              
              <!-- 拟合方法（仅拟合后差分模式显示） -->
              <div id="fittingMethodSection">
                <label class="text-xs text-gray-600">原始数据拟合方法</label>
                <select id="fittingMethod" class="w-full px-2 py-1 border border-gray-300 rounded text-xs mb-1">
                  <option value="spline" selected>三次样条</option>
                  <option value="polynomial">多项式</option>
                  <option value="bspline">B样条</option>
                  <option value="loess">LOESS</option>
                  <option value="gaussian">高斯过程</option>
                </select>
                <div id="polynomialParams" class="hidden"><label class="text-xs">阶数: <span id="polyDegreeValue">5</span></label><input type="range" id="polyDegree" min="2" max="15" value="5" class="w-full h-1"></div>
                <div id="bsplineParams" class="hidden">
                  <label class="text-xs">阶数: <span id="bsplineDegreeValue">3</span></label><input type="range" id="bsplineDegree" min="2" max="5" value="3" class="w-full h-1">
                  <label class="text-xs">节点: <span id="bsplineKnotsValue">15</span></label><input type="range" id="bsplineKnots" min="5" max="50" value="15" class="w-full h-1">
                </div>
                <div id="loessParams" class="hidden"><label class="text-xs">范围: <span id="loessSpanValue">0.30</span></label><input type="range" id="loessSpan" min="0.1" max="1" step="0.05" value="0.3" class="w-full h-1"></div>
                <div id="gaussianParams" class="hidden"><label class="text-xs">长度尺度: <span id="gpLengthScaleValue">0.10</span></label><input type="range" id="gpLengthScale" min="0.01" max="1" step="0.01" value="0.1" class="w-full h-1"></div>
                <label class="text-xs">输出点数: <span id="numPointsValue">200</span></label><input type="range" id="numPoints" min="50" max="500" step="10" value="200" class="w-full h-1">
              </div>
              
              <!-- 直接差分参数（仅直接差分模式显示） -->
              <div id="directDiffSection" class="hidden">
                <div class="border-t border-gray-200 pt-2 mt-2">
                  <h3 class="text-xs font-semibold text-cyan-700 mb-1">直接差分参数</h3>
                  <!-- dQ/dV 直接差分 -->
                  <div class="mb-2">
                    <label class="text-xs text-gray-600 font-medium">dQ/dV 参数</label>
                    <div class="grid grid-cols-2 gap-1 mt-1">
                      <div>
                        <label class="text-xs text-gray-500">算法</label>
                        <select id="directDqdvMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                          <option value="savitzky_golay" selected>SG微分</option>
                          <option value="center">中心差分</option>
                          <option value="forward">前向差分</option>
                          <option value="backward">后向差分</option>
                        </select>
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">窗口: <span id="directDqdvWindowValue">5</span></label>
                        <input type="range" id="directDqdvWindow" min="3" max="11" step="2" value="5" class="w-full h-1">
                      </div>
                    </div>
                    <label class="flex items-center gap-1 text-xs mt-1">
                      <input type="checkbox" id="directDqdvSmoothing" checked class="accent-cyan-500"> 平滑
                    </label>
                    <div class="grid grid-cols-2 gap-1 mt-1">
                      <select id="directDqdvSmoothingMethod" class="px-1 py-0.5 border border-gray-300 rounded text-xs">
                        <option value="savitzky_golay" selected>SG</option>
                        <option value="moving_average">移动平均</option>
                        <option value="gaussian">高斯</option>
                      </select>
                      <div>
                        <label class="text-xs">窗口: <span id="directDqdvSmoothWindowValue">7</span></label>
                        <input type="range" id="directDqdvSmoothWindow" min="3" max="21" step="2" value="7" class="w-full h-1">
                      </div>
                    </div>
                  </div>
                  <!-- dV/dQ 直接差分 -->
                  <div class="border-t border-gray-200 pt-2">
                    <label class="text-xs text-gray-600 font-medium">dV/dQ 参数</label>
                    <div class="grid grid-cols-2 gap-1 mt-1">
                      <div>
                        <label class="text-xs text-gray-500">算法</label>
                        <select id="directDvdqMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                          <option value="savitzky_golay" selected>SG微分</option>
                          <option value="center">中心差分</option>
                          <option value="forward">前向差分</option>
                          <option value="backward">后向差分</option>
                        </select>
                      </div>
                      <div>
                        <label class="text-xs text-gray-500">窗口: <span id="directDvdqWindowValue">5</span></label>
                        <input type="range" id="directDvdqWindow" min="3" max="11" step="2" value="5" class="w-full h-1">
                      </div>
                    </div>
                    <label class="flex items-center gap-1 text-xs mt-1">
                      <input type="checkbox" id="directDvdqSmoothing" checked class="accent-cyan-500"> 平滑
                    </label>
                    <div class="grid grid-cols-2 gap-1 mt-1">
                      <select id="directDvdqSmoothingMethod" class="px-1 py-0.5 border border-gray-300 rounded text-xs">
                        <option value="savitzky_golay" selected>SG</option>
                        <option value="moving_average">移动平均</option>
                        <option value="gaussian">高斯</option>
                      </select>
                      <div>
                        <label class="text-xs">窗口: <span id="directDvdqSmoothWindowValue">7</span></label>
                        <input type="range" id="directDvdqSmoothWindow" min="3" max="21" step="2" value="7" class="w-full h-1">
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              <!-- 差分曲线拟合参数（仅直接差分模式显示） -->
              <div id="diffCurveFittingSection" class="hidden">
                <div class="border-t border-gray-200 pt-2 mt-2">
                  <h3 class="text-xs font-semibold text-teal-700 mb-1">差分曲线拟合</h3>
                  <label class="flex items-center gap-1 text-xs">
                    <input type="checkbox" id="diffCurveFittingEnabled" checked class="accent-teal-500">
                    <span>启用差分曲线拟合</span>
                  </label>
                  <select id="diffCurveFittingMethod" class="w-full px-2 py-1 border border-gray-300 rounded text-xs mt-1">
                    <option value="spline" selected>三次样条</option>
                    <option value="polynomial">多项式</option>
                    <option value="bspline">B样条</option>
                    <option value="loess">LOESS</option>
                  </select>
                  <div id="diffCurvePolyParams" class="hidden mt-1">
                    <label class="text-xs">阶数: <span id="diffCurvePolyDegreeValue">5</span></label>
                    <input type="range" id="diffCurvePolyDegree" min="2" max="15" value="5" class="w-full h-1">
                  </div>
                  <div id="diffCurveBsplineParams" class="hidden mt-1">
                    <label class="text-xs">阶数: <span id="diffCurveBsplineDegreeValue">3</span></label>
                    <input type="range" id="diffCurveBsplineDegree" min="2" max="5" value="3" class="w-full h-1">
                    <label class="text-xs">节点: <span id="diffCurveBsplineKnotsValue">15</span></label>
                    <input type="range" id="diffCurveBsplineKnots" min="5" max="50" value="15" class="w-full h-1">
                  </div>
                  <div id="diffCurveLoessParams" class="hidden mt-1">
                    <label class="text-xs">范围: <span id="diffCurveLoessSpanValue">0.30</span></label>
                    <input type="range" id="diffCurveLoessSpan" min="0.1" max="1" step="0.05" value="0.3" class="w-full h-1">
                  </div>
                  <label class="text-xs mt-1">拟合点数: <span id="diffCurveNumPointsValue">200</span></label>
                  <input type="range" id="diffCurveNumPoints" min="50" max="500" step="10" value="200" class="w-full h-1">
                  <div class="border-t border-gray-200 pt-1 mt-1">
                    <label class="flex items-center gap-1 text-xs">
                      <input type="checkbox" id="diffCurvePostSmoothing" checked class="accent-teal-500">
                      <span>拟合后平滑</span>
                    </label>
                    <div class="grid grid-cols-2 gap-1 mt-1">
                      <select id="diffCurvePostSmoothingMethod" class="px-1 py-0.5 border border-gray-300 rounded text-xs">
                        <option value="savitzky_golay" selected>SG</option>
                        <option value="moving_average">移动平均</option>
                        <option value="gaussian">高斯</option>
                      </select>
                      <div>
                        <label class="text-xs">窗口: <span id="diffCurvePostSmoothWindowValue">5</span></label>
                        <input type="range" id="diffCurvePostSmoothWindow" min="3" max="15" step="2" value="5" class="w-full h-1">
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              <div id="fitQuality" class="text-xs mt-2 pt-1 border-t border-gray-200">
                <div>R² Q=f(V): <span id="r2QV" class="font-mono text-green-600">-</span></div>
                <div>R² V=g(Q): <span id="r2VQ" class="font-mono text-green-600">-</span></div>
              </div>
              <!-- 拟合后差分按钮（仅该模式下显示） -->
              <button id="performFitting" class="w-full mt-2 bg-blue-500 hover:bg-blue-600 text-white font-medium py-1 rounded text-xs disabled:opacity-50" disabled>拟合曲线</button>
              <!-- 直接差分按钮（仅该模式下显示） -->
              <button id="performDirectDiff" class="w-full mt-2 bg-cyan-500 hover:bg-cyan-600 text-white font-medium py-1 rounded text-xs disabled:opacity-50 hidden" disabled>直接差分</button>
            </div>

            <!-- dQ/dV 参数 -->
            <div class="bg-green-50 rounded-lg shadow p-2 border border-green-200">
              <h2 class="text-xs font-semibold text-green-800 mb-1">📈 dQ/dV 参数</h2>
              <div class="grid grid-cols-2 gap-1">
                <div>
                  <label class="text-xs text-gray-600">求导方式</label>
                  <select id="dqdvMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                    <option value="analytical">解析</option>
                    <option value="numerical_center">中心差分</option>
                    <option value="numerical_forward">前向差分</option>
                    <option value="numerical_backward">后向差分</option>
                    <option value="improved">改进方法</option>
                  </select>
                </div>
                <div>
                  <label class="text-xs text-gray-600">窗口: <span id="dqdvWindowValue">1</span></label>
                  <input type="range" id="dqdvWindow" min="1" max="11" step="2" value="1" class="w-full h-1">
                </div>
              </div>
              <label class="flex items-center gap-1 text-xs mt-1">
                <input type="checkbox" id="dqdvEnableSmoothing" checked class="accent-green-500"> 启用平滑
              </label>
              <div id="dqdvSmoothingParams" class="grid grid-cols-2 gap-1 mt-1">
                <select id="dqdvSmoothingMethod" class="px-1 py-0.5 border border-gray-300 rounded text-xs">
                  <option value="savitzky_golay" selected>SG</option>
                  <option value="moving_average">移动平均</option>
                  <option value="gaussian">高斯</option>
                </select>
                <div>
                  <label class="text-xs">窗口: <span id="dqdvSmoothingWindowValue">7</span></label>
                  <input type="range" id="dqdvSmoothingWindow" min="3" max="21" step="2" value="7" class="w-full h-1">
                </div>
              </div>
              
              <!-- dQ/dV 峰检测 -->
              <div class="border-t border-green-300 pt-1 mt-1">
                <label class="flex items-center gap-1 text-xs font-semibold text-green-800">
                  <input type="checkbox" id="dqdvEnablePeak" checked class="accent-green-600"> 🔍 启用寻峰
                </label>
                <div id="dqdvPeakParams" class="grid grid-cols-2 gap-1 mt-1">
                  <div class="col-span-2">
                    <label class="text-xs text-gray-600">寻峰方式</label>
                    <select id="dqdvPeakMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                      <option value="scipy_style" selected>Scipy风格</option>
                      <option value="local_extrema">局部极值法</option>
                      <option value="derivative">导数法</option>
                      <option value="zero_crossing">零交叉法</option>
                      <option value="window">窗口平均法</option>
                      <option value="shoulder">肩膀峰检测</option>
                      <option value="curvature">曲率法</option>
                      <option value="second_derivative">二阶导数法</option>
                    </select>
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">峰高 (Ah/V):</label>
                    <input type="number" id="dqdvMinHeight" step="any" value="0" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">间距 (V):</label>
                    <input type="number" id="dqdvMinDistance" step="any" value="0.01" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">显著性 (Ah/V):</label>
                    <input type="number" id="dqdvProminence" step="any" value="0" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                  </div>
                  <div class="flex items-end">
                    <label class="flex items-center gap-1 text-xs">
                      <input type="checkbox" id="dqdvEnableNegativePeaks" class="accent-green-500"> 波谷
                    </label>
                  </div>
                </div>
                <div id="dqdvWindowSizeDiv" class="hidden">
                  <label class="text-xs text-gray-600">窗口大小:</label>
                  <input type="number" id="dqdvWindowSize" min="3" max="50" value="5" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                </div>
              </div>
              
              <button id="calculateDqdv" class="w-full mt-2 bg-green-500 hover:bg-green-600 text-white font-medium py-1 rounded text-xs disabled:opacity-50" disabled>计算 dQ/dV</button>
            </div>

            <!-- dV/dQ 参数 -->
            <div class="bg-purple-50 rounded-lg shadow p-2 border border-purple-200">
              <h2 class="text-xs font-semibold text-purple-800 mb-1">📉 dV/dQ 参数</h2>
              <div class="grid grid-cols-2 gap-1">
                <div>
                  <label class="text-xs text-gray-600">求导方式</label>
                  <select id="dvdqMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                    <option value="analytical">解析</option>
                    <option value="numerical_center">中心差分</option>
                    <option value="numerical_forward">前向差分</option>
                    <option value="numerical_backward">后向差分</option>
                    <option value="improved" selected>改进方法</option>
                  </select>
                </div>
                <div>
                  <label class="text-xs text-gray-600">窗口: <span id="dvdqWindowValue">1</span></label>
                  <input type="range" id="dvdqWindow" min="1" max="11" step="2" value="1" class="w-full h-1">
                </div>
              </div>
              <label class="flex items-center gap-1 text-xs mt-1">
                <input type="checkbox" id="dvdqEnableSmoothing" checked class="accent-purple-500"> 启用平滑
              </label>
              <div id="dvdqSmoothingParams" class="grid grid-cols-2 gap-1 mt-1">
                <select id="dvdqSmoothingMethod" class="px-1 py-0.5 border border-gray-300 rounded text-xs">
                  <option value="savitzky_golay" selected>SG</option>
                  <option value="moving_average">移动平均</option>
                  <option value="gaussian">高斯</option>
                </select>
                <div>
                  <label class="text-xs">窗口: <span id="dvdqSmoothingWindowValue">7</span></label>
                  <input type="range" id="dvdqSmoothingWindow" min="3" max="21" step="2" value="7" class="w-full h-1">
                </div>
              </div>
              
              <!-- dV/dQ 峰检测 -->
              <div class="border-t border-purple-300 pt-1 mt-1">
                <label class="flex items-center gap-1 text-xs font-semibold text-purple-800">
                  <input type="checkbox" id="dvdqEnablePeak" checked class="accent-purple-600"> 🔍 启用寻峰
                </label>
                <div id="dvdqPeakParams" class="grid grid-cols-2 gap-1 mt-1">
                  <div class="col-span-2">
                    <label class="text-xs text-gray-600">寻峰方式</label>
                    <select id="dvdqPeakMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                      <option value="scipy_style" selected>Scipy风格</option>
                      <option value="local_extrema">局部极值法</option>
                      <option value="derivative">导数法</option>
                      <option value="zero_crossing">零交叉法</option>
                      <option value="window">窗口平均法</option>
                      <option value="shoulder">肩膀峰检测</option>
                      <option value="curvature">曲率法</option>
                      <option value="second_derivative">二阶导数法</option>
                    </select>
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">峰高 (V/Ah):</label>
                    <input type="number" id="dvdqMinHeight" step="any" value="0" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">间距 (Ah):</label>
                    <input type="number" id="dvdqMinDistance" step="any" value="0.01" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">显著性 (V/Ah):</label>
                    <input type="number" id="dvdqProminence" step="any" value="0" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                  </div>
                  <div class="flex items-end">
                    <label class="flex items-center gap-1 text-xs">
                      <input type="checkbox" id="dvdqEnableNegativePeaks" class="accent-purple-500"> 波谷
                    </label>
                  </div>
                </div>
                <div id="dvdqWindowSizeDiv" class="hidden">
                  <label class="text-xs text-gray-600">窗口大小:</label>
                  <input type="number" id="dvdqWindowSize" min="3" max="50" value="5" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                </div>
              </div>
              
              <button id="calculateDvdq" class="w-full mt-2 bg-purple-500 hover:bg-purple-600 text-white font-medium py-1 rounded text-xs disabled:opacity-50" disabled>计算 dV/dQ</button>
            </div>

            <!-- dQ/dI 参数（恒压充电模式下的差分电流分析） -->
            <div class="bg-orange-50 rounded-lg shadow p-2 border border-orange-200">
              <h2 class="text-xs font-semibold text-orange-800 mb-1">⚡ dQ/dI 参数 (CV充电)</h2>
              <p class="text-xs text-gray-500 mb-1">恒压充电模式下的差分电流分析</p>
              
              <!-- I-Q曲线拟合参数 -->
              <div class="border-t border-orange-200 pt-2 mt-1">
                <h3 class="text-xs font-semibold text-orange-700 mb-1">📈 I-Q 曲线拟合</h3>
                <div class="grid grid-cols-2 gap-1">
                  <div>
                    <label class="text-xs text-gray-600">拟合方法</label>
                    <select id="dqdiFittingMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                      <option value="polynomial" selected>多项式</option>
                      <option value="spline">三次样条</option>
                      <option value="bspline">B样条</option>
                      <option value="exponential">指数衰减</option>
                    </select>
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">阶数/节点: <span id="dqdiFitDegreeValue">5</span></label>
                    <input type="range" id="dqdiFitDegree" min="2" max="15" value="5" class="w-full h-1">
                  </div>
                </div>
                <div class="flex items-center gap-1 mt-1">
                  <label class="flex items-center gap-1 text-xs">
                    <input type="checkbox" id="dqdiShowFitted" checked class="accent-orange-500">
                    <span>显示拟合曲线</span>
                  </label>
                </div>
              </div>
              
              <!-- dQ/dI 差分算法参数 -->
              <div class="border-t border-orange-200 pt-2 mt-1">
                <h3 class="text-xs font-semibold text-orange-700 mb-1">📉 dQ/dI 差分算法</h3>
                <div class="grid grid-cols-2 gap-1">
                  <div>
                    <label class="text-xs text-gray-600">求导方式</label>
                    <select id="dqdiMethod" class="w-full px-1 py-0.5 border border-gray-300 rounded text-xs">
                      <option value="analytical" selected>解析</option>
                      <option value="numerical_center">中心差分</option>
                      <option value="robust">稳健算法</option>
                    </select>
                  </div>
                  <div>
                    <label class="text-xs text-gray-600">窗口: <span id="dqdiWindowValue">1</span></label>
                    <input type="range" id="dqdiWindow" min="1" max="11" step="2" value="1" class="w-full h-1">
                  </div>
                </div>
                <label class="flex items-center gap-1 text-xs mt-1">
                  <input type="checkbox" id="dqdiEnableSmoothing" checked class="accent-orange-500"> 启用平滑
                </label>
                <div id="dqdiSmoothingParams" class="grid grid-cols-2 gap-1 mt-1">
                  <select id="dqdiSmoothingMethod" class="px-1 py-0.5 border border-gray-300 rounded text-xs">
                    <option value="savitzky_golay" selected>SG</option>
                    <option value="moving_average">移动平均</option>
                    <option value="gaussian">高斯</option>
                  </select>
                  <div>
                    <label class="text-xs">窗口: <span id="dqdiSmoothingWindowValue">5</span></label>
                    <input type="range" id="dqdiSmoothingWindow" min="3" max="21" step="2" value="5" class="w-full h-1">
                  </div>
                </div>
              </div>
              
              <button id="calculateDqdi" class="w-full mt-2 bg-orange-500 hover:bg-orange-600 text-white font-medium py-1 rounded text-xs disabled:opacity-50" disabled>计算 dQ/dI</button>
            </div>
          </div>

          <!-- 右侧图表区域 -->
          <div class="lg:col-span-3 space-y-3" id="chartsContainer">
            <!-- 拟合曲线图 - 增大尺寸 -->
            <div class="bg-white rounded-lg shadow p-3 border border-gray-100">
              <div class="flex justify-between items-center mb-2">
                <h3 class="text-sm font-semibold text-gray-800">📊 拟合曲线 (电压 vs 容量)</h3>
                <div class="flex gap-1 items-center">
                  <label class="flex items-center gap-1 text-xs cursor-pointer">
                    <input type="checkbox" id="editModeToggle" class="w-3 h-3">
                    <span>编辑模式</span>
                  </label>
                  <button id="restoreAllData" class="text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>恢复全部</button>
                </div>
              </div>
              <div id="rawChartContainer" style="height: 280px; position: relative;"><canvas id="rawChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">容量范围:</span>
                <input type="number" id="rawChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="rawChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="rawChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="rawChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <!-- 编辑工具栏 -->
              <div id="editToolbar" class="hidden mt-2 p-2 bg-yellow-50 rounded border border-yellow-200">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-xs text-yellow-800 font-medium">图表: <span id="selectionChart">-</span></span>
                  <span class="text-xs text-yellow-800">|</span>
                  <span class="text-xs text-yellow-800">X: <span id="selectionXRange">-</span></span>
                  <span class="text-xs text-yellow-800">Y: <span id="selectionYRange">-</span></span>
                  <div class="flex gap-1">
                    <button id="deleteSelection" class="text-xs bg-red-500 hover:bg-red-600 text-white px-2 py-0.5 rounded" disabled>删除</button>
                    <button id="colorSelection" class="text-xs bg-purple-500 hover:bg-purple-600 text-white px-2 py-0.5 rounded" disabled>标颜色</button>
                    <button id="restoreSelection" class="text-xs bg-green-500 hover:bg-green-600 text-white px-2 py-0.5 rounded" disabled>恢复</button>
                  </div>
                  <input type="color" id="selectionColor" value="#ff6b6b" class="w-6 h-6 rounded cursor-pointer" title="选择标注颜色">
                  <button id="clearSelection" class="text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 px-2 py-0.5 rounded">清除选择</button>
                  <button id="pointDeleteMode" class="text-xs bg-orange-500 hover:bg-orange-600 text-white px-2 py-0.5 rounded" title="点击图表上的数据点删除">🎯 点删</button>
                </div>
                <div id="pointDeleteHint" class="hidden mt-1 text-xs text-orange-600 text-center">
                  点选删除模式已开启，点击图表上的数据点可删除
                </div>
              </div>
              <!-- 编辑历史 -->
              <div id="editHistory" class="hidden mt-2 p-2 bg-gray-50 rounded text-xs max-h-20 overflow-y-auto">
                <div class="font-semibold text-gray-700 mb-1">编辑历史:</div>
                <div id="editHistoryList" class="space-y-1"></div>
              </div>
            </div>
            
            <!-- dQ/dV 图表 -->
            <div class="bg-white rounded-lg shadow p-3 border border-gray-100">
              <div class="flex justify-between items-center mb-2">
                <h3 class="text-sm font-semibold text-green-700">📈 dQ/dV vs 电压</h3>
                <div class="flex gap-1">
                  <button id="copyDqdvData" class="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDqdvExcel" class="text-xs bg-green-500 hover:bg-green-600 text-white px-2 py-0.5 rounded disabled:opacity-50" disabled>Excel</button>
                  <button id="exportDqdvImage" class="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dqdvChartContainer" style="height: 250px; position: relative;"><canvas id="dqdvChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">电压范围:</span>
                <input type="number" id="dqdvChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dqdvChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dqdvChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dqdvChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <!-- dQ/dV 编辑提示 -->
              <div id="dqdvEditHint" class="hidden mt-1 text-xs text-center text-yellow-600 bg-yellow-50 py-1 rounded">
                编辑模式下可在图表上拖拽选择区域
              </div>
              <div id="dqdvPeaksInfo" class="hidden mt-2 p-2 bg-green-50 rounded text-xs">
                <div class="flex justify-between items-center mb-1">
                  <span class="font-semibold text-green-800">检测到 <span id="dqdvPeakCount">0</span> 个峰</span>
                  <button id="copyDqdvPeaks" class="text-xs bg-green-200 hover:bg-green-300 text-green-800 px-2 py-0.5 rounded">复制</button>
                </div>
                <div id="dqdvPeaksTable" class="overflow-x-auto max-h-24 overflow-y-auto font-mono whitespace-pre text-xs"></div>
              </div>
              <div id="dqdvExport" class="hidden mt-2">
                <textarea id="dqdvDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-green-50 resize-none" readonly></textarea>
                <button id="copyDqdvClipboard" class="mt-1 text-xs bg-green-500 hover:bg-green-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>
            
            <!-- dV/dQ 图表 -->
            <div class="bg-white rounded-lg shadow p-3 border border-gray-100">
              <div class="flex justify-between items-center mb-2">
                <h3 class="text-sm font-semibold text-purple-700">📉 dV/dQ vs 容量</h3>
                <div class="flex gap-1">
                  <button id="copyDvdqData" class="text-xs bg-purple-100 hover:bg-purple-200 text-purple-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDvdqExcel" class="text-xs bg-purple-500 hover:bg-purple-600 text-white px-2 py-0.5 rounded disabled:opacity-50" disabled>Excel</button>
                  <button id="exportDvdqImage" class="text-xs bg-purple-100 hover:bg-purple-200 text-purple-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dvdqChartContainer" style="height: 250px; position: relative;"><canvas id="dvdqChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">容量范围:</span>
                <input type="number" id="dvdqChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dvdqChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dvdqChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dvdqChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <!-- dV/dQ 编辑提示 -->
              <div id="dvdqEditHint" class="hidden mt-1 text-xs text-center text-yellow-600 bg-yellow-50 py-1 rounded">
                编辑模式下可在图表上拖拽选择区域
              </div>
              <div id="dvdqPeaksInfo" class="hidden mt-2 p-2 bg-purple-50 rounded text-xs">
                <div class="flex justify-between items-center mb-1">
                  <span class="font-semibold text-purple-800">检测到 <span id="dvdqPeakCount">0</span> 个峰</span>
                  <button id="copyDvdqPeaks" class="text-xs bg-purple-200 hover:bg-purple-300 text-purple-800 px-2 py-0.5 rounded">复制</button>
                </div>
                <div id="dvdqPeaksTable" class="overflow-x-auto max-h-24 overflow-y-auto font-mono whitespace-pre text-xs"></div>
              </div>
              <div id="dvdqExport" class="hidden mt-2">
                <textarea id="dvdqDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-purple-50 resize-none" readonly></textarea>
                <button id="copyDvdqClipboard" class="mt-1 text-xs bg-purple-500 hover:bg-purple-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- dSOC/dV 图表 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-orange-700">📊 dSOC/dV 曲线</h2>
                <div class="flex gap-1">
                  <button id="copyDsocdvData" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDsocdvImage" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dsocdvChartContainer" style="height: 250px; position: relative;"><canvas id="dsocdvChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">电压范围:</span>
                <input type="number" id="dsocdvChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dsocdvChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dsocdvChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dsocdvChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="dsocdvPeakInfo" class="mt-1 text-xs bg-orange-50 rounded p-1.5 hidden">
                <table class="w-full text-center">
                  <thead>
                    <tr class="text-orange-700 font-semibold">
                      <th class="py-0.5">数据集</th>
                      <th class="py-0.5">最高峰值</th>
                      <th class="py-0.5">0.45V峰值</th>
                      <th class="py-0.5">比值(0.45V/最高)</th>
                    </tr>
                  </thead>
                  <tbody id="dsocdvPeakTableBody"></tbody>
                </table>
              </div>
              <div id="dsocdvExport" class="hidden mt-2">
                <textarea id="dsocdvDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-orange-50 resize-none" readonly></textarea>
                <button id="copyDsocdvClipboard" class="mt-1 text-xs bg-orange-500 hover:bg-orange-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- ========== 新增曲线图表区域 ========== -->

            <!-- dQ/dV vs Q 曲线 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-teal-700">📊 dQ/dV-Q 曲线</h2>
                <div class="flex gap-1">
                  <button id="copyDqdvQData" class="text-xs bg-teal-100 hover:bg-teal-200 text-teal-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDqdvQImage" class="text-xs bg-teal-100 hover:bg-teal-200 text-teal-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dqdvQChartContainer" style="height: 200px; position: relative;"><canvas id="dqdvQChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">容量 Q范围:</span>
                <input type="number" id="dqdvQChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dqdvQChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dqdvQChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dqdvQChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="dqdvQExport" class="hidden mt-2">
                <textarea id="dqdvQDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-teal-50 resize-none" readonly></textarea>
                <button id="copyDqdvQClipboard" class="mt-1 text-xs bg-teal-500 hover:bg-teal-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- dQ/dV vs SOC 曲线 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-cyan-700">📊 dQ/dV-SOC 曲线</h2>
                <div class="flex gap-1">
                  <button id="copyDqdvSocData" class="text-xs bg-cyan-100 hover:bg-cyan-200 text-cyan-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDqdvSocImage" class="text-xs bg-cyan-100 hover:bg-cyan-200 text-cyan-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dqdvSocChartContainer" style="height: 200px; position: relative;"><canvas id="dqdvSocChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">SOC范围:</span>
                <input type="number" id="dqdvSocChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dqdvSocChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dqdvSocChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dqdvSocChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="dqdvSocExport" class="hidden mt-2">
                <textarea id="dqdvSocDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-cyan-50 resize-none" readonly></textarea>
                <button id="copyDqdvSocClipboard" class="mt-1 text-xs bg-cyan-500 hover:bg-cyan-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- dV/dQ vs V 曲线 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-rose-700">📊 dV/dQ-V 曲线</h2>
                <div class="flex gap-1">
                  <button id="copyDvdqVData" class="text-xs bg-rose-100 hover:bg-rose-200 text-rose-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDvdqVImage" class="text-xs bg-rose-100 hover:bg-rose-200 text-rose-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dvdqVChartContainer" style="height: 200px; position: relative;"><canvas id="dvdqVChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">电压 V范围:</span>
                <input type="number" id="dvdqVChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dvdqVChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dvdqVChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dvdqVChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="dvdqVExport" class="hidden mt-2">
                <textarea id="dvdqVDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-rose-50 resize-none" readonly></textarea>
                <button id="copyDvdqVClipboard" class="mt-1 text-xs bg-rose-500 hover:bg-rose-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- dV/dQ vs SOC 曲线 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-pink-700">📊 dV/dQ-SOC 曲线</h2>
                <div class="flex gap-1">
                  <button id="copyDvdqSocData" class="text-xs bg-pink-100 hover:bg-pink-200 text-pink-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDvdqSocImage" class="text-xs bg-pink-100 hover:bg-pink-200 text-pink-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dvdqSocChartContainer" style="height: 200px; position: relative;"><canvas id="dvdqSocChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">SOC范围:</span>
                <input type="number" id="dvdqSocChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dvdqSocChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dvdqSocChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dvdqSocChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="dvdqSocExport" class="hidden mt-2">
                <textarea id="dvdqSocDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-pink-50 resize-none" readonly></textarea>
                <button id="copyDvdqSocClipboard" class="mt-1 text-xs bg-pink-500 hover:bg-pink-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- dSOC/dV vs Q 曲线 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-amber-700">📊 dSOC/dV-Q 曲线</h2>
                <div class="flex gap-1">
                  <button id="copyDsocdvQData" class="text-xs bg-amber-100 hover:bg-amber-200 text-amber-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDsocdvQImage" class="text-xs bg-amber-100 hover:bg-amber-200 text-amber-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dsocdvQChartContainer" style="height: 200px; position: relative;"><canvas id="dsocdvQChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">容量 Q范围:</span>
                <input type="number" id="dsocdvQChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dsocdvQChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dsocdvQChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dsocdvQChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="dsocdvQExport" class="hidden mt-2">
                <textarea id="dsocdvQDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-amber-50 resize-none" readonly></textarea>
                <button id="copyDsocdvQClipboard" class="mt-1 text-xs bg-amber-500 hover:bg-amber-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- dSOC/dV vs SOC 曲线 -->
            <div class="bg-white rounded-lg shadow p-2 border border-gray-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-lime-700">📊 dSOC/dV-SOC 曲线</h2>
                <div class="flex gap-1">
                  <button id="copyDsocdvSocData" class="text-xs bg-lime-100 hover:bg-lime-200 text-lime-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportDsocdvSocImage" class="text-xs bg-lime-100 hover:bg-lime-200 text-lime-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="dsocdvSocChartContainer" style="height: 200px; position: relative;"><canvas id="dsocdvSocChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">SOC范围:</span>
                <input type="number" id="dsocdvSocChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dsocdvSocChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dsocdvSocChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dsocdvSocChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="dsocdvSocExport" class="hidden mt-2">
                <textarea id="dsocdvSocDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-lime-50 resize-none" readonly></textarea>
                <button id="copyDsocdvSocClipboard" class="mt-1 text-xs bg-lime-500 hover:bg-lime-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- V-SOC 曲线（充放电曲线） -->
            <div class="bg-white rounded-lg shadow p-2 border border-teal-100">
              <div class="flex justify-between items-center mb-1">
                <h2 class="text-xs font-semibold text-teal-700">🔋 V-SOC 充放电曲线</h2>
                <div class="flex gap-1">
                  <button id="copyVSocData" class="text-xs bg-teal-100 hover:bg-teal-200 text-teal-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                  <button id="exportVSocImage" class="text-xs bg-teal-100 hover:bg-teal-200 text-teal-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                </div>
              </div>
              <div id="vSocChartContainer" style="height: 200px; position: relative;"><canvas id="vSocChart"></canvas></div>
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">SOC范围:</span>
                <input type="number" id="vSocChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="vSocChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="vSocChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="vSocChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
              <div id="vSocExport" class="hidden mt-2">
                <textarea id="vSocDataArea" class="w-full h-16 px-2 py-1 border rounded text-xs font-mono bg-teal-50 resize-none" readonly></textarea>
                <button id="copyVSocClipboard" class="mt-1 text-xs bg-teal-500 hover:bg-teal-600 text-white px-2 py-0.5 rounded">复制到剪贴板</button>
              </div>
            </div>

            <!-- dQ/dI 分析图表（恒压充电模式）- 纵向排列 -->
            <div class="bg-white rounded-lg shadow p-3 border border-orange-100">
              <div class="flex justify-between items-center mb-2">
                <h3 class="text-sm font-semibold text-orange-800">⚡ dQ/dI 分析 (恒压充电模式)</h3>
                <div class="text-xs text-gray-500">基于 Ko et al. (2024)</div>
              </div>
              <p class="text-xs text-gray-500 mb-2">dQ/dI = I/(dI/dt)，用于SOH和SOC估计</p>
              <div class="space-y-3">
                <!-- I-Q 曲线 - 拟合曲线 -->
                <div class="bg-orange-50 rounded p-2">
                  <div class="flex justify-between items-center mb-1">
                    <h4 class="text-xs font-semibold text-orange-700">📈 I-Q 曲线 (拟合)</h4>
                    <div class="flex gap-1">
                      <button id="copyCurrentCapacityData" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                      <button id="exportCurrentCapacityImage" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                    </div>
                  </div>
                  <div id="currentCapacityChartContainer" style="height: 200px; position: relative;">
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">容量 Q范围:</span>
                <input type="number" id="currentCapacityChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="currentCapacityChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="currentCapacityChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="currentCapacityChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
                    <canvas id="currentCapacityChart"></canvas>
                  </div>
                </div>
                <!-- dQ/dI vs I 曲线 -->
                <div class="bg-orange-50 rounded p-2">
                  <div class="flex justify-between items-center mb-1">
                    <h4 class="text-xs font-semibold text-orange-700">📉 dQ/dI vs I</h4>
                    <div class="flex gap-1">
                      <button id="copyDqdiData" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                      <button id="exportDqdiImage" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                    </div>
                  </div>
                  <div id="dqdiChartContainer" style="height: 200px; position: relative;">
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">电流 I范围:</span>
                <input type="number" id="dqdiChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="dqdiChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="dqdiChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="dqdiChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
                    <canvas id="dqdiChart"></canvas>
                  </div>
                </div>
                <!-- dI/dQ vs Q 曲线 -->
                <div class="bg-orange-50 rounded p-2">
                  <div class="flex justify-between items-center mb-1">
                    <h4 class="text-xs font-semibold text-orange-700">📊 dI/dQ vs Q</h4>
                    <div class="flex gap-1">
                      <button id="copyDidqData" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>复制</button>
                      <button id="exportDidqImage" class="text-xs bg-orange-100 hover:bg-orange-200 text-orange-700 px-2 py-0.5 rounded disabled:opacity-50" disabled>图片</button>
                    </div>
                  </div>
                  <div id="didqChartContainer" style="height: 200px; position: relative;">
              <div class="mt-1 flex items-center gap-2 text-xs bg-gray-50 rounded p-1.5">
                <span class="text-gray-600 font-medium">容量 Q范围:</span>
                <input type="number" id="didqChartXMin" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最小值" step="any">
                <span class="text-gray-400">~</span>
                <input type="number" id="didqChartXMax" class="w-20 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder="最大值" step="any">
                <button id="didqChartXApply" class="px-2 py-0.5 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs">应用</button>
                <button id="didqChartXReset" class="px-2 py-0.5 bg-gray-400 hover:bg-gray-500 text-white rounded text-xs">重置</button>
              </div>
                    <canvas id="didqChart"></canvas>
                  </div>
                </div>
              </div>
              </div>
              
              <!-- 恒压阶段特征常数显示区域 -->
              <div id="characteristicsInfo"></div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 批量粘贴模态框 -->
      <div id="batchPasteModal" class="fixed inset-0 bg-black bg-opacity-50 z-50 hidden flex items-center justify-center">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col">
          <div class="flex justify-between items-center p-3 border-b border-gray-200 bg-purple-50 rounded-t-lg">
            <h3 class="text-sm font-semibold text-purple-800">📋 批量粘贴多个数据集</h3>
            <button id="closeBatchPasteModal" class="text-gray-500 hover:text-gray-700 text-lg">&times;</button>
          </div>
          <div class="p-3 flex-1 overflow-y-auto">
            <p class="text-xs text-gray-600 mb-2">粘贴格式说明：</p>
            <div class="bg-gray-50 rounded p-2 mb-3 text-xs">
              <p class="font-semibold text-gray-700 mb-1">【横向格式】每2列或3列数据为一个数据集</p>
              <pre class="text-gray-600 whitespace-pre-wrap">数据集1名称		数据集2名称
电压	容量	电压	容量
4.2	0.00	4.2	0.00
4.1	0.05	4.1	0.08
4.0	0.10	4.0	0.15</pre>
              <p class="font-semibold text-gray-700 mb-1 mt-2">【纵向格式】用空行或分隔符分隔</p>
              <pre class="text-gray-600 whitespace-pre-wrap"># 数据集1名称
电压	容量
4.2	0.00
4.1	0.05

# 数据集2名称
电压	容量
4.2	0.00
4.1	0.08

===分隔===
# 数据集3名称
电压	容量
4.2	0.00
4.1	0.10</pre>
            </div>
            <textarea id="batchPasteInput" class="w-full h-48 px-2 py-1 border border-gray-300 rounded text-xs font-mono resize-none" placeholder="在此粘贴数据..."></textarea>
            <div class="flex items-center gap-2 mt-2">
              <label class="flex items-center gap-1 text-xs">
                <input type="checkbox" id="batchPasteClearExisting" class="accent-purple-500">
                <span>清空现有数据集</span>
              </label>
            </div>
          </div>
          <div class="flex gap-2 p-3 border-t border-gray-200 bg-gray-50 rounded-b-lg">
            <button id="batchPasteLoadSample" class="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 py-1.5 px-3 rounded text-xs">加载示例</button>
            <button id="batchPasteConfirm" class="flex-1 bg-purple-500 hover:bg-purple-600 text-white py-1.5 px-3 rounded text-xs font-medium">确认导入</button>
            <button id="batchPasteCancel" class="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-700 py-1.5 px-3 rounded text-xs">取消</button>
          </div>
        </div>
      </div>
    </div>
  `;

  initEventListeners();
}

// 示例数据（横向格式 - 推荐用于多数据集）
const SAMPLE_DATA_HORIZONTAL = `A1-初始		A2-初始		A3-初始		B1-初始		B2-初始
电压	容量	电压	容量	电压	容量	电压	容量	电压	容量
4.418	6.553489	4.4199	0	4.4177	6.5548	4.4295	0	4.4255	0
4.3991	6.553489	4.401	6.552886	4.3991	6.5548	4.4072	6.553506	4.4022	6.552236
4.392	13.10702	4.3939	13.1057	4.3917	13.10971	4.3998	13.10699	4.3951	13.10443
4.387	19.66055	4.3892	19.6587	4.387	19.66464	4.3951	19.66052	4.3901	19.65667
4.3833	26.21413	4.3852	26.2117	4.3833	26.2196	4.3914	26.2141	4.3867	26.20895
4.3799	32.76774	4.3821	32.7646	4.3796	32.77437	4.388	32.76761	4.3836	32.76121
4.3771	39.32136	4.3793	39.31759	4.3771	39.32907	4.3852	39.32114	4.3805	39.31342
4.3746	45.87495	4.3765	45.87055	4.374	45.88371	4.3824	45.87464	4.3781	45.86562
4.3718	52.42848	4.374	52.42369	4.3718	52.43834	4.3799	52.42812	4.3756	52.41781
4.3697	58.98201	4.3718	58.97667	4.3697	58.99306	4.3777	58.98158	4.3731	58.97002`;

// 示例数据（纵向格式）
const SAMPLE_DATA_VERTICAL = `# 样品1 - 正常电池
电压,容量
3.000,0.000
3.100,0.009
3.200,0.022
3.300,0.039
3.400,0.062
3.500,0.092
3.600,0.130
3.700,0.178
3.800,0.237
3.900,0.311
4.000,0.402
4.100,0.514
4.200,0.649
4.300,0.810
4.400,1.000

# 样品2 - 老化电池
3.000,0.000
3.100,0.007
3.200,0.018
3.300,0.032
3.400,0.050
3.500,0.075
3.600,0.105
3.700,0.145
3.800,0.195
3.900,0.255
4.000,0.330
4.100,0.420
4.200,0.530
4.300,0.660
4.400,0.800`;

// 充电数据示例（横向格式）
const SAMPLE_CHARGE_DATA = `CC-CV测试1		CC-CV测试2
电流	电压	容量	电流	电压	容量
1.0	3.5	0.00	1.0	3.6	0.00
1.0	3.6	0.01	1.0	3.8	0.02
1.0	3.7	0.02	1.0	4.0	0.04
1.0	3.8	0.03	1.0	4.1	0.05
1.0	3.9	0.04	0.5	4.2	0.07
1.0	4.0	0.05	0.3	4.2	0.09
1.0	4.1	0.06	0.1	4.2	0.12
0.8	4.2	0.07			
0.6	4.2	0.09			
0.4	4.2	0.11			
0.2	4.2	0.14			
0.1	4.2	0.16`;

// 默认示例（横向格式）
const SAMPLE_DATA = SAMPLE_DATA_HORIZONTAL;

function initEventListeners(): void {
  const dataInput = document.getElementById('dataInput') as HTMLTextAreaElement;
  
  // 数据类型选择器事件
  const dataTypeDischargeBtn = document.getElementById('dataTypeDischarge');
  const dataTypeChargeBtn = document.getElementById('dataTypeCharge');
  const dataTypeHint = document.getElementById('dataTypeHint');
  const chargeModeOptions = document.getElementById('chargeModeOptions');
  
  // 充电模式切换辅助函数
  const updateChargeModeUI = () => {
    const ccModeHint = document.getElementById('ccModeHint');
    const cvModeOptionsEl = document.getElementById('cvModeOptions');
    const cccvModeOptionsEl = document.getElementById('cccvModeOptions');
    const chargeModeCC = document.getElementById('chargeModeCC');
    const chargeModeCV = document.getElementById('chargeModeCV');
    const chargeModeCCCV = document.getElementById('chargeModeCCCV');
    const dataInputEl = document.getElementById('dataInput') as HTMLTextAreaElement;
    
    // 重置所有按钮样式
    [chargeModeCC, chargeModeCV, chargeModeCCCV].forEach(btn => {
      btn?.classList.remove('bg-orange-500', 'text-white');
      btn?.classList.add('bg-gray-100', 'text-gray-600');
    });
    
    // 隐藏所有选项
    ccModeHint?.classList.add('hidden');
    cvModeOptionsEl?.classList.add('hidden');
    cccvModeOptionsEl?.classList.add('hidden');
    
    // 显示当前模式对应的UI
    if (state.chargeMode === 'cc') {
      chargeModeCC?.classList.remove('bg-gray-100', 'text-gray-600');
      chargeModeCC?.classList.add('bg-orange-500', 'text-white');
      ccModeHint?.classList.remove('hidden');
      if (dataInputEl) {
        dataInputEl.placeholder = '恒流充电：输入2列数据（电压、容量）\n\n示例：\n电压\t容量\n3.0\t0.001\n3.1\t0.002\n\n支持多数据集：每2列为一个数据集';
      }
    } else if (state.chargeMode === 'cv') {
      chargeModeCV?.classList.remove('bg-gray-100', 'text-gray-600');
      chargeModeCV?.classList.add('bg-orange-500', 'text-white');
      cvModeOptionsEl?.classList.remove('hidden');
      if (dataInputEl) {
        const colType = state.cvColumnType === 'current-capacity' ? '电流、容量' : '电流、时间';
        dataInputEl.placeholder = `恒压充电：输入2列数据（${colType}）\n\n示例：\n电流\t${state.cvColumnType === 'current-capacity' ? '容量' : '时间'}\n1000\t${state.cvColumnType === 'current-capacity' ? '0.01' : '10'}\n800\t${state.cvColumnType === 'current-capacity' ? '0.02' : '20'}\n\n支持多数据集：每2列为一个数据集`;
      }
    } else if (state.chargeMode === 'cccv') {
      chargeModeCCCV?.classList.remove('bg-gray-100', 'text-gray-600');
      chargeModeCCCV?.classList.add('bg-orange-500', 'text-white');
      cccvModeOptionsEl?.classList.remove('hidden');
      if (dataInputEl) {
        const colType = state.cccvColumnType === 'current-voltage-capacity' ? '电流、电压、容量' : '电流、电压、时间';
        dataInputEl.placeholder = `CC-CV充电：输入3列数据（${colType}）\n\n示例：\n电流\t电压\t${state.cccvColumnType === 'current-voltage-capacity' ? '容量' : '时间'}\n1000\t3.0\t${state.cccvColumnType === 'current-voltage-capacity' ? '0.001' : '10'}\n800\t4.2\t${state.cccvColumnType === 'current-voltage-capacity' ? '0.1' : '100'}\n\n自动区分恒流/恒压段`;
      }
    }
  };
  
  dataTypeDischargeBtn?.addEventListener('click', () => {
    state.currentDataType = 'discharge';
    dataTypeDischargeBtn.classList.remove('bg-gray-100', 'text-gray-600');
    dataTypeDischargeBtn.classList.add('bg-blue-500', 'text-white');
    dataTypeChargeBtn?.classList.remove('bg-blue-500', 'text-white');
    dataTypeChargeBtn?.classList.add('bg-gray-100', 'text-gray-600');
    if (dataTypeHint) dataTypeHint.textContent = '放电数据: dQ/dV、dV/dQ 分析';
    chargeModeOptions?.classList.add('hidden');
    // 更新placeholder
    const dataInputEl = document.getElementById('dataInput') as HTMLTextAreaElement;
    if (dataInputEl) {
      dataInputEl.placeholder = '支持横向/纵向格式粘贴数据：\n\n【横向格式】每2列为一个数据集，从Excel直接复制\n  数据集1\t\t数据集2\n  电压\t容量\t电压\t容量\n  4.0\t0.01\t4.0\t0.02\n\n【纵向格式】每行一组数据，用 #名称 分隔多个数据集\n  # 样品1\n  3.0,0.001\n  3.1,0.002';
    }
  });
  
  dataTypeChargeBtn?.addEventListener('click', () => {
    state.currentDataType = 'charge';
    dataTypeChargeBtn.classList.remove('bg-gray-100', 'text-gray-600');
    dataTypeChargeBtn.classList.add('bg-blue-500', 'text-white');
    dataTypeDischargeBtn?.classList.remove('bg-blue-500', 'text-white');
    dataTypeDischargeBtn?.classList.add('bg-gray-100', 'text-gray-600');
    if (dataTypeHint) dataTypeHint.textContent = '充电数据: 根据充电模式选择输入格式';
    chargeModeOptions?.classList.remove('hidden');
    updateChargeModeUI();
  });
  
  // 充电模式切换
  document.getElementById('chargeModeCC')?.addEventListener('click', () => {
    state.chargeMode = 'cc';
    updateChargeModeUI();
  });
  
  document.getElementById('chargeModeCV')?.addEventListener('click', () => {
    state.chargeMode = 'cv';
    updateChargeModeUI();
  });
  
  document.getElementById('chargeModeCCCV')?.addEventListener('click', () => {
    state.chargeMode = 'cccv';
    updateChargeModeUI();
  });
  
  // CV数据列类型切换
  document.getElementById('cvColumnType')?.addEventListener('change', (e) => {
    state.cvColumnType = (e.target as HTMLSelectElement).value as CVColumnType;
    updateChargeModeUI();  // 更新placeholder
  });
  
  // CCCV数据列类型切换
  document.getElementById('cccvColumnType')?.addEventListener('change', (e) => {
    state.cccvColumnType = (e.target as HTMLSelectElement).value as CCCVColumnType;
    updateChargeModeUI();  // 更新placeholder
  });

  document.getElementById('loadSampleData')?.addEventListener('click', () => {
    if (dataInput) { 
      // 根据当前数据类型加载不同的示例数据
      dataInput.value = state.currentDataType === 'charge' ? SAMPLE_CHARGE_DATA : SAMPLE_DATA; 
    }
  });

  // 添加数据集
  document.getElementById('addDataset')?.addEventListener('click', () => {
    const text = dataInput?.value.trim();
    if (!text) {
      showDataInfo('请输入数据', true);
      return;
    }
    addDatasetsFromText(text);
  });

  // 清空所有数据集
  document.getElementById('clearAllData')?.addEventListener('click', () => {
    if (dataInput) dataInput.value = '';
    state.datasets = [];
    state.activeDatasetId = null;
    resetUI();
    updateDatasetList();
  });

  // 批量导入文件
  document.getElementById('batchImportFiles')?.addEventListener('change', async (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files || files.length === 0) return;
    
    let successCount = 0;
    let failCount = 0;
    const errors: string[] = [];
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileName = file.name.replace(/\.[^/.]+$/, ''); // 移除扩展名
      
      try {
        const text = await file.text();
        const result = parseDataText(text, fileName);
        if (result) {
          successCount++;
        } else {
          failCount++;
          errors.push(`${file.name}: 解析失败`);
        }
      } catch (err) {
        failCount++;
        errors.push(`${file.name}: ${err}`);
      }
    }
    
    // 显示导入结果
    if (successCount > 0) {
      updateDatasetList();
      updateButtonsState();
      updateAllCharts();
      showDataInfo(`成功导入 ${successCount} 个数据集${failCount > 0 ? `，失败 ${failCount} 个` : ''}`);
    }
    if (errors.length > 0) {
      console.warn('导入错误:', errors);
    }
    
    // 清空文件输入，允许重复导入同名文件
    (e.target as HTMLInputElement).value = '';
  });

  // 批量粘贴模态框相关事件
  const batchPasteModal = document.getElementById('batchPasteModal');
  const batchPasteInput = document.getElementById('batchPasteInput') as HTMLTextAreaElement;
  const batchPasteClearExisting = document.getElementById('batchPasteClearExisting') as HTMLInputElement;

  // 打开批量粘贴模态框
  document.getElementById('openBatchPasteModal')?.addEventListener('click', () => {
    if (batchPasteModal) batchPasteModal.classList.remove('hidden');
  });

  // 关闭批量粘贴模态框
  document.getElementById('closeBatchPasteModal')?.addEventListener('click', () => {
    if (batchPasteModal) batchPasteModal.classList.add('hidden');
  });

  // 取消按钮
  document.getElementById('batchPasteCancel')?.addEventListener('click', () => {
    if (batchPasteModal) batchPasteModal.classList.add('hidden');
  });

  // 点击模态框背景关闭
  batchPasteModal?.addEventListener('click', (e) => {
    if (e.target === batchPasteModal) {
      batchPasteModal.classList.add('hidden');
    }
  });

  // 加载示例数据
  document.getElementById('batchPasteLoadSample')?.addEventListener('click', () => {
    // 生成批量粘贴示例数据
    const sampleText = `# 电池样品A - 新电池
电压,容量
4.20,0.000
4.10,0.050
4.00,0.100
3.90,0.150
3.80,0.200
3.70,0.240
3.60,0.275
3.50,0.305
3.40,0.330
3.30,0.352
3.20,0.370

# 电池样品B - 老化电池
电压,容量
4.20,0.000
4.10,0.040
4.00,0.085
3.90,0.130
3.80,0.170
3.70,0.205
3.60,0.235
3.50,0.260
3.40,0.280
3.30,0.298
3.20,0.312

===分隔===

# 电池样品C - 衰减电池
电压,容量
4.20,0.000
4.10,0.045
4.00,0.092
3.90,0.138
3.80,0.180
3.70,0.218
3.60,0.250
3.50,0.278
3.40,0.302
3.30,0.322
3.20,0.340`;
    if (batchPasteInput) batchPasteInput.value = sampleText;
  });

  // 确认导入按钮
  document.getElementById('batchPasteConfirm')?.addEventListener('click', () => {
    const text = batchPasteInput?.value.trim();
    if (!text) {
      showDataInfo('请粘贴数据', true);
      return;
    }

    // 如果勾选了清空选项
    if (batchPasteClearExisting?.checked) {
      state.datasets = [];
      state.activeDatasetId = null;
    }

    // 使用现有的 addDatasetsFromText 函数处理
    addDatasetsFromText(text);

    // 关闭模态框
    if (batchPasteModal) batchPasteModal.classList.add('hidden');

    // 清空输入
    if (batchPasteInput) batchPasteInput.value = '';
  });

  // 全选/取消全选数据集
  document.getElementById('selectAllDatasets')?.addEventListener('change', (e) => {
    toggleSelectAll((e.target as HTMLInputElement).checked);
  });

  // 汇总导出所有数据集
  document.getElementById('exportAllDatasets')?.addEventListener('click', () => {
    exportAllDatasetsToExcel();
  });

  // 差分模式选择
  const diffModeFitted = document.getElementById('diffModeFitted');
  const diffModeDirect = document.getElementById('diffModeDirect');
  const diffModeHint = document.getElementById('diffModeHint');
  const fittingMethodSection = document.getElementById('fittingMethodSection');
  const directDiffSection = document.getElementById('directDiffSection');
  const diffCurveFittingSection = document.getElementById('diffCurveFittingSection');
  
  const updateDiffModeUI = () => {
    const performFittingBtn = document.getElementById('performFitting');
    const performDirectDiffBtn = document.getElementById('performDirectDiff');
    
    if (state.diffMode === 'fitted') {
      diffModeFitted?.classList.remove('bg-gray-100', 'text-gray-600');
      diffModeFitted?.classList.add('bg-blue-500', 'text-white');
      diffModeDirect?.classList.remove('bg-teal-500', 'text-white');
      diffModeDirect?.classList.add('bg-gray-100', 'text-gray-600');
      if (diffModeHint) diffModeHint.textContent = '拟合后差分：先拟合曲线，再求导';
      fittingMethodSection?.classList.remove('hidden');
      directDiffSection?.classList.add('hidden');
      diffCurveFittingSection?.classList.add('hidden');
      // 显示拟合曲线按钮，隐藏直接差分按钮
      performFittingBtn?.classList.remove('hidden');
      performDirectDiffBtn?.classList.add('hidden');
    } else {
      diffModeDirect?.classList.remove('bg-gray-100', 'text-gray-600');
      diffModeDirect?.classList.add('bg-teal-500', 'text-white');
      diffModeFitted?.classList.remove('bg-blue-500', 'text-white');
      diffModeFitted?.classList.add('bg-gray-100', 'text-gray-600');
      if (diffModeHint) diffModeHint.textContent = '直接差分：直接求导，再拟合差分曲线';
      fittingMethodSection?.classList.add('hidden');
      directDiffSection?.classList.remove('hidden');
      diffCurveFittingSection?.classList.remove('hidden');
      // 隐藏拟合曲线按钮，显示直接差分按钮
      performFittingBtn?.classList.add('hidden');
      performDirectDiffBtn?.classList.remove('hidden');
    }
  };
  
  diffModeFitted?.addEventListener('click', () => {
    state.diffMode = 'fitted';
    updateDiffModeUI();
  });
  
  diffModeDirect?.addEventListener('click', () => {
    state.diffMode = 'direct';
    updateDiffModeUI();
  });
  
  // 直接差分参数事件监听器
  const directDqdvMethod = document.getElementById('directDqdvMethod') as HTMLSelectElement;
  directDqdvMethod?.addEventListener('change', (e) => {
    state.directDiffParams.dqdv.method = (e.target as HTMLSelectElement).value as any;
  });
  bindSlider('directDqdvWindow', 'directDqdvWindowValue', v => state.directDiffParams.dqdv.windowSize = v);
  
  const directDqdvSmoothing = document.getElementById('directDqdvSmoothing') as HTMLInputElement;
  directDqdvSmoothing?.addEventListener('change', (e) => {
    state.directDiffParams.dqdv.enableSmoothing = (e.target as HTMLInputElement).checked;
  });
  
  const directDqdvSmoothingMethod = document.getElementById('directDqdvSmoothingMethod') as HTMLSelectElement;
  directDqdvSmoothingMethod?.addEventListener('change', (e) => {
    state.directDiffParams.dqdv.smoothingMethod = (e.target as HTMLSelectElement).value as any;
  });
  bindSlider('directDqdvSmoothWindow', 'directDqdvSmoothWindowValue', v => state.directDiffParams.dqdv.smoothingWindow = v);
  
  // dV/dQ 直接差分参数事件监听器
  const directDvdqMethod = document.getElementById('directDvdqMethod') as HTMLSelectElement;
  directDvdqMethod?.addEventListener('change', (e) => {
    state.directDiffParams.dvdq.method = (e.target as HTMLSelectElement).value as any;
  });
  bindSlider('directDvdqWindow', 'directDvdqWindowValue', v => state.directDiffParams.dvdq.windowSize = v);
  
  const directDvdqSmoothing = document.getElementById('directDvdqSmoothing') as HTMLInputElement;
  directDvdqSmoothing?.addEventListener('change', (e) => {
    state.directDiffParams.dvdq.enableSmoothing = (e.target as HTMLInputElement).checked;
  });
  
  const directDvdqSmoothingMethod = document.getElementById('directDvdqSmoothingMethod') as HTMLSelectElement;
  directDvdqSmoothingMethod?.addEventListener('change', (e) => {
    state.directDiffParams.dvdq.smoothingMethod = (e.target as HTMLSelectElement).value as any;
  });
  bindSlider('directDvdqSmoothWindow', 'directDvdqSmoothWindowValue', v => state.directDiffParams.dvdq.smoothingWindow = v);
  
  // 差分曲线拟合参数事件监听器
  const diffCurveFittingEnabled = document.getElementById('diffCurveFittingEnabled') as HTMLInputElement;
  diffCurveFittingEnabled?.addEventListener('change', (e) => {
    state.diffCurveFittingParams.enabled = (e.target as HTMLInputElement).checked;
  });
  
  const diffCurveFittingMethod = document.getElementById('diffCurveFittingMethod') as HTMLSelectElement;
  const diffCurvePolyParams = document.getElementById('diffCurvePolyParams');
  const diffCurveBsplineParams = document.getElementById('diffCurveBsplineParams');
  const diffCurveLoessParams = document.getElementById('diffCurveLoessParams');
  
  diffCurveFittingMethod?.addEventListener('change', (e) => {
    state.diffCurveFittingParams.method = (e.target as HTMLSelectElement).value as any;
    // 显示/隐藏相应的参数面板
    diffCurvePolyParams?.classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'polynomial');
    diffCurveBsplineParams?.classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'bspline');
    diffCurveLoessParams?.classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'loess');
  });
  
  bindSlider('diffCurvePolyDegree', 'diffCurvePolyDegreeValue', v => state.diffCurveFittingParams.polynomialDegree = v);
  bindSlider('diffCurveBsplineDegree', 'diffCurveBsplineDegreeValue', v => state.diffCurveFittingParams.bsplineDegree = v);
  bindSlider('diffCurveBsplineKnots', 'diffCurveBsplineKnotsValue', v => state.diffCurveFittingParams.bsplineKnots = v);
  bindSlider('diffCurveLoessSpan', 'diffCurveLoessSpanValue', v => state.diffCurveFittingParams.loessSpan = v, true);
  bindSlider('diffCurveNumPoints', 'diffCurveNumPointsValue', v => state.diffCurveFittingParams.numPoints = v);
  
  const diffCurvePostSmoothing = document.getElementById('diffCurvePostSmoothing') as HTMLInputElement;
  diffCurvePostSmoothing?.addEventListener('change', (e) => {
    state.diffCurveFittingParams.enablePostSmoothing = (e.target as HTMLInputElement).checked;
  });
  
  const diffCurvePostSmoothingMethod = document.getElementById('diffCurvePostSmoothingMethod') as HTMLSelectElement;
  diffCurvePostSmoothingMethod?.addEventListener('change', (e) => {
    state.diffCurveFittingParams.postSmoothingMethod = (e.target as HTMLSelectElement).value as any;
  });
  bindSlider('diffCurvePostSmoothWindow', 'diffCurvePostSmoothWindowValue', v => state.diffCurveFittingParams.postSmoothingWindow = v);

  // 拟合方法
  const fittingMethod = document.getElementById('fittingMethod') as HTMLSelectElement;
  fittingMethod?.addEventListener('change', (e) => {
    state.fittingParams.method = (e.target as HTMLSelectElement).value as FittingMethod;
    updateFittingParamPanels(state.fittingParams.method);
  });

  bindSlider('polyDegree', 'polyDegreeValue', v => state.fittingParams.polynomialDegree = v);
  bindSlider('bsplineDegree', 'bsplineDegreeValue', v => state.fittingParams.bsplineDegree = v);
  bindSlider('bsplineKnots', 'bsplineKnotsValue', v => state.fittingParams.bsplineKnots = v);
  bindSlider('loessSpan', 'loessSpanValue', v => state.fittingParams.loessSpan = v, true);
  bindSlider('gpLengthScale', 'gpLengthScaleValue', v => state.fittingParams.gpLengthScale = v, true);
  bindSlider('numPoints', 'numPointsValue', v => state.fittingParams.numPoints = v);

  // dQ/dV 参数
  const dqdvMethod = document.getElementById('dqdvMethod') as HTMLSelectElement;
  dqdvMethod?.addEventListener('change', (e) => {
    state.diffParams.dqdv.method = (e.target as HTMLSelectElement).value as DifferentialMethod;
  });
  bindSlider('dqdvWindow', 'dqdvWindowValue', v => state.diffParams.dqdv.windowSize = v);
  
  const dqdvEnableSmoothing = document.getElementById('dqdvEnableSmoothing') as HTMLInputElement;
  const dqdvSmoothingParams = document.getElementById('dqdvSmoothingParams');
  dqdvEnableSmoothing?.addEventListener('change', (e) => {
    state.diffParams.dqdv.enableSmoothing = (e.target as HTMLInputElement).checked;
    if (dqdvSmoothingParams) dqdvSmoothingParams.style.opacity = state.diffParams.dqdv.enableSmoothing ? '1' : '0.5';
  });
  
  const dqdvSmoothingMethod = document.getElementById('dqdvSmoothingMethod') as HTMLSelectElement;
  dqdvSmoothingMethod?.addEventListener('change', (e) => {
    state.diffParams.dqdv.smoothingMethod = (e.target as HTMLSelectElement).value as 'moving_average' | 'savitzky_golay' | 'gaussian';
  });
  bindSlider('dqdvSmoothingWindow', 'dqdvSmoothingWindowValue', v => state.diffParams.dqdv.smoothingWindow = v);

  // dQ/dV 峰检测参数
  const dqdvEnablePeak = document.getElementById('dqdvEnablePeak') as HTMLInputElement;
  const dqdvPeakParamsDiv = document.getElementById('dqdvPeakParams');
  dqdvEnablePeak?.addEventListener('change', (e) => {
    state.peakParams.dqdv.enabled = (e.target as HTMLInputElement).checked;
    if (dqdvPeakParamsDiv) dqdvPeakParamsDiv.style.opacity = state.peakParams.dqdv.enabled ? '1' : '0.5';
  });

  const dqdvPeakMethod = document.getElementById('dqdvPeakMethod') as HTMLSelectElement;
  const dqdvWindowSizeDiv = document.getElementById('dqdvWindowSizeDiv');
  dqdvPeakMethod?.addEventListener('change', (e) => {
    state.peakParams.dqdv.method = (e.target as HTMLSelectElement).value as any;
    // 显示/隐藏窗口大小参数
    if (dqdvWindowSizeDiv) {
      dqdvWindowSizeDiv.classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'window');
    }
  });

  bindPeakInput('dqdvMinHeight', v => state.peakParams.dqdv.minHeight = v);
  bindPeakInput('dqdvMinDistance', v => state.peakParams.dqdv.minDistance = v);
  bindPeakInput('dqdvProminence', v => state.peakParams.dqdv.prominence = v);
  bindPeakInput('dqdvWindowSize', v => state.peakParams.dqdv.windowSize = Math.max(3, v), true);
  
  const dqdvEnableNegativePeaks = document.getElementById('dqdvEnableNegativePeaks') as HTMLInputElement;
  dqdvEnableNegativePeaks?.addEventListener('change', (e) => {
    state.peakParams.dqdv.enableNegativePeaks = (e.target as HTMLInputElement).checked;
  });

  // dV/dQ 参数
  const dvdqMethod = document.getElementById('dvdqMethod') as HTMLSelectElement;
  dvdqMethod?.addEventListener('change', (e) => {
    state.diffParams.dvdq.method = (e.target as HTMLSelectElement).value as DifferentialMethod;
  });
  bindSlider('dvdqWindow', 'dvdqWindowValue', v => state.diffParams.dvdq.windowSize = v);
  
  const dvdqEnableSmoothing = document.getElementById('dvdqEnableSmoothing') as HTMLInputElement;
  const dvdqSmoothingParams = document.getElementById('dvdqSmoothingParams');
  dvdqEnableSmoothing?.addEventListener('change', (e) => {
    state.diffParams.dvdq.enableSmoothing = (e.target as HTMLInputElement).checked;
    if (dvdqSmoothingParams) dvdqSmoothingParams.style.opacity = state.diffParams.dvdq.enableSmoothing ? '1' : '0.5';
  });
  
  const dvdqSmoothingMethod = document.getElementById('dvdqSmoothingMethod') as HTMLSelectElement;
  dvdqSmoothingMethod?.addEventListener('change', (e) => {
    state.diffParams.dvdq.smoothingMethod = (e.target as HTMLSelectElement).value as 'moving_average' | 'savitzky_golay' | 'gaussian';
  });
  bindSlider('dvdqSmoothingWindow', 'dvdqSmoothingWindowValue', v => state.diffParams.dvdq.smoothingWindow = v);

  // dV/dQ 峰检测参数
  const dvdqEnablePeak = document.getElementById('dvdqEnablePeak') as HTMLInputElement;
  const dvdqPeakParamsDiv = document.getElementById('dvdqPeakParams');
  dvdqEnablePeak?.addEventListener('change', (e) => {
    state.peakParams.dvdq.enabled = (e.target as HTMLInputElement).checked;
    if (dvdqPeakParamsDiv) dvdqPeakParamsDiv.style.opacity = state.peakParams.dvdq.enabled ? '1' : '0.5';
  });

  const dvdqPeakMethod = document.getElementById('dvdqPeakMethod') as HTMLSelectElement;
  const dvdqWindowSizeDiv = document.getElementById('dvdqWindowSizeDiv');
  dvdqPeakMethod?.addEventListener('change', (e) => {
    state.peakParams.dvdq.method = (e.target as HTMLSelectElement).value as any;
    // 显示/隐藏窗口大小参数
    if (dvdqWindowSizeDiv) {
      dvdqWindowSizeDiv.classList.toggle('hidden', (e.target as HTMLSelectElement).value !== 'window');
    }
  });

  bindPeakInput('dvdqMinHeight', v => state.peakParams.dvdq.minHeight = v);
  bindPeakInput('dvdqMinDistance', v => state.peakParams.dvdq.minDistance = v);
  bindPeakInput('dvdqProminence', v => state.peakParams.dvdq.prominence = v);
  bindPeakInput('dvdqWindowSize', v => state.peakParams.dvdq.windowSize = Math.max(3, v), true);
  
  const dvdqEnableNegativePeaks = document.getElementById('dvdqEnableNegativePeaks') as HTMLInputElement;
  dvdqEnableNegativePeaks?.addEventListener('change', (e) => {
    state.peakParams.dvdq.enableNegativePeaks = (e.target as HTMLInputElement).checked;
  });

  // 分开计算按钮
  document.getElementById('calculateDqdv')?.addEventListener('click', () => {
    if (state.datasets.length > 0) performCalculation('dqdv');
  });
  document.getElementById('calculateDvdq')?.addEventListener('click', () => {
    if (state.datasets.length > 0) performCalculation('dvdq');
  });
  
  // dQ/dI 参数（恒压充电模式）
  const dqdiMethod = document.getElementById('dqdiMethod') as HTMLSelectElement;
  dqdiMethod?.addEventListener('change', (e) => {
    state.dqdiParams.method = (e.target as HTMLSelectElement).value as DifferentialMethod;
  });
  bindSlider('dqdiWindow', 'dqdiWindowValue', v => state.dqdiParams.windowSize = v);
  
  const dqdiEnableSmoothing = document.getElementById('dqdiEnableSmoothing') as HTMLInputElement;
  const dqdiSmoothingParams = document.getElementById('dqdiSmoothingParams');
  dqdiEnableSmoothing?.addEventListener('change', (e) => {
    state.dqdiParams.enableSmoothing = (e.target as HTMLInputElement).checked;
    if (dqdiSmoothingParams) dqdiSmoothingParams.style.opacity = state.dqdiParams.enableSmoothing ? '1' : '0.5';
  });
  
  const dqdiSmoothingMethod = document.getElementById('dqdiSmoothingMethod') as HTMLSelectElement;
  dqdiSmoothingMethod?.addEventListener('change', (e) => {
    state.dqdiParams.smoothingMethod = (e.target as HTMLSelectElement).value as 'moving_average' | 'savitzky_golay' | 'gaussian';
  });
  bindSlider('dqdiSmoothingWindow', 'dqdiSmoothingWindowValue', v => state.dqdiParams.smoothingWindow = v);
  
  // dQ/dI I-Q曲线拟合参数
  const dqdiFittingMethod = document.getElementById('dqdiFittingMethod') as HTMLSelectElement;
  dqdiFittingMethod?.addEventListener('change', (e) => {
    state.dqdiParams.fittingMethod = (e.target as HTMLSelectElement).value as 'polynomial' | 'spline' | 'bspline' | 'exponential';
  });
  bindSlider('dqdiFitDegree', 'dqdiFitDegreeValue', v => state.dqdiParams.fittingDegree = v);
  
  // 显示拟合曲线开关
  const dqdiShowFitted = document.getElementById('dqdiShowFitted') as HTMLInputElement;
  dqdiShowFitted?.addEventListener('change', (e) => {
    state.dqdiParams.showFittedCurve = (e.target as HTMLInputElement).checked;
    updateCurrentCapacityChart();
  });
  
  // 计算 dQ/dI 按钮
  document.getElementById('calculateDqdi')?.addEventListener('click', () => {
    if (state.datasets.length > 0) performDqdiCalculation();
  });
  
  // 拟合曲线按钮
  document.getElementById('performFitting')?.addEventListener('click', () => {
    if (state.datasets.length > 0) performFittingOnly();
  });

  // 直接差分按钮
  document.getElementById('performDirectDiff')?.addEventListener('click', () => {
    if (state.datasets.length > 0) performDirectDifferentialOnly();
  });

  // 复制数据和导出图片
  document.getElementById('copyDqdvData')?.addEventListener('click', () => showDqdvExport());
  document.getElementById('copyDqdvClipboard')?.addEventListener('click', () => copyToClipboard('dqdvDataArea'));
  document.getElementById('exportDqdvImage')?.addEventListener('click', () => exportChartImage('dqdvChartContainer', 'dqdv-chart.png'));
  document.getElementById('exportDqdvExcel')?.addEventListener('click', () => exportToExcel('dqdv'));
  document.getElementById('copyDqdvPeaks')?.addEventListener('click', () => {
    const activeDataset = getActiveDataset();
    if (activeDataset && activeDataset.peaks.dqdv.length > 0) {
      copyTextToClipboard(exportPeaksCSV(activeDataset.peaks.dqdv, '电压(V)', 'dQ/dV(Ah/V)'));
    }
  });
  
  document.getElementById('copyDvdqData')?.addEventListener('click', () => showDvdqExport());
  document.getElementById('copyDvdqClipboard')?.addEventListener('click', () => copyToClipboard('dvdqDataArea'));
  document.getElementById('exportDvdqImage')?.addEventListener('click', () => exportChartImage('dvdqChartContainer', 'dvdq-chart.png'));
  document.getElementById('exportDvdqExcel')?.addEventListener('click', () => exportToExcel('dvdq'));
  document.getElementById('copyDvdqPeaks')?.addEventListener('click', () => {
    const activeDataset = getActiveDataset();
    if (activeDataset && activeDataset.peaks.dvdq.length > 0) {
      copyTextToClipboard(exportPeaksCSV(activeDataset.peaks.dvdq, '容量(Ah)', 'dV/dQ(V/Ah)'));
    }
  });
  
  // dSOC/dV 相关事件
  document.getElementById('copyDsocdvData')?.addEventListener('click', () => showDsocdvExport());
  document.getElementById('exportDsocdvExcel')?.addEventListener('click', () => exportToExcel('dsocdv'));
  document.getElementById('exportDsocdvImage')?.addEventListener('click', () => exportChartImage('dsocdvChartContainer', 'dsocdv-chart.png'));
  document.getElementById('copyDsocdvPeaks')?.addEventListener('click', () => {
    const activeDataset = getActiveDataset();
    if (activeDataset && activeDataset.peaks.dsocdv.length > 0) {
      copyTextToClipboard(exportPeaksCSV(activeDataset.peaks.dsocdv, '电压(V)', 'dSOC/dV(1/V)'));
    }
  });
  
  // ========== 新增曲线事件监听 ==========
  // dQ/dV vs Q
  document.getElementById('copyDqdvQData')?.addEventListener('click', () => showDqdvQExport());
  document.getElementById('exportDqdvQImage')?.addEventListener('click', () => exportChartImage('dqdvQChartContainer', 'dqdv-q-chart.png'));
  
  // dQ/dV vs SOC
  document.getElementById('copyDqdvSocData')?.addEventListener('click', () => showDqdvSocExport());
  document.getElementById('exportDqdvSocImage')?.addEventListener('click', () => exportChartImage('dqdvSocChartContainer', 'dqdv-soc-chart.png'));
  
  // dV/dQ vs V
  document.getElementById('copyDvdqVData')?.addEventListener('click', () => showDvdqVExport());
  document.getElementById('exportDvdqVImage')?.addEventListener('click', () => exportChartImage('dvdqVChartContainer', 'dvdq-v-chart.png'));
  
  // dV/dQ vs SOC
  document.getElementById('copyDvdqSocData')?.addEventListener('click', () => showDvdqSocExport());
  document.getElementById('exportDvdqSocImage')?.addEventListener('click', () => exportChartImage('dvdqSocChartContainer', 'dvdq-soc-chart.png'));
  
  // dSOC/dV vs Q
  document.getElementById('copyDsocdvQData')?.addEventListener('click', () => showDsocdvQExport());
  document.getElementById('exportDsocdvQImage')?.addEventListener('click', () => exportChartImage('dsocdvQChartContainer', 'dsocdv-q-chart.png'));
  
  // dSOC/dV vs SOC
  document.getElementById('copyDsocdvSocData')?.addEventListener('click', () => showDsocdvSocExport());
  document.getElementById('exportDsocdvSocImage')?.addEventListener('click', () => exportChartImage('dsocdvSocChartContainer', 'dsocdv-soc-chart.png'));
  
  // 横坐标范围编辑事件
  const xAxisConfigs = [
    { chartId: 'rawChart', chart: () => state.charts.raw },
    { chartId: 'dqdvChart', chart: () => state.charts.dqdv },
    { chartId: 'dvdqChart', chart: () => state.charts.dvdq },
    { chartId: 'dsocdvChart', chart: () => state.charts.dsocdv },
    { chartId: 'dqdvQChart', chart: () => state.charts.dqdvQ },
    { chartId: 'dqdvSocChart', chart: () => state.charts.dqdvSoc },
    { chartId: 'dvdqVChart', chart: () => state.charts.dvdqV },
    { chartId: 'dvdqSocChart', chart: () => state.charts.dvdqSoc },
    { chartId: 'dsocdvQChart', chart: () => state.charts.dsocdvQ },
    { chartId: 'dsocdvSocChart', chart: () => state.charts.dsocdvSoc },
    { chartId: 'vSocChart', chart: () => state.charts.vSoc },
    { chartId: 'currentCapacityChart', chart: () => state.charts.currentCapacity },
    { chartId: 'dqdiChart', chart: () => state.charts.dqdi },
    { chartId: 'didqChart', chart: () => state.charts.didq },
  ];
  
  xAxisConfigs.forEach(({ chartId, chart }) => {
    document.getElementById(`${chartId}XApply`)?.addEventListener('click', () => applyXAxisRange(chartId, chart()));
    document.getElementById(`${chartId}XReset`)?.addEventListener('click', () => resetXAxisRange(chartId, chart()));
  });
  
  // 编辑模式相关事件
  document.getElementById('editModeToggle')?.addEventListener('change', (e) => {
    state.editMode = (e.target as HTMLInputElement).checked;
    const toolbar = document.getElementById('editToolbar');
    const history = document.getElementById('editHistory');
    if (state.editMode) {
      toolbar?.classList.remove('hidden');
      history?.classList.remove('hidden');
      setupChartSelection();
    } else {
      toolbar?.classList.add('hidden');
      history?.classList.add('hidden');
      clearSelection();
    }
  });
  
  document.getElementById('deleteSelection')?.addEventListener('click', deleteSelectedRange);
  document.getElementById('colorSelection')?.addEventListener('click', colorSelectedRange);
  document.getElementById('restoreSelection')?.addEventListener('click', restoreSelectedRange);
  document.getElementById('clearSelection')?.addEventListener('click', clearSelection);
  document.getElementById('restoreAllData')?.addEventListener('click', restoreAllData);
  
  // 点选删除模式
  document.getElementById('pointDeleteMode')?.addEventListener('click', () => {
    state.pointDeleteMode = !state.pointDeleteMode;
    const btn = document.getElementById('pointDeleteMode');
    const hint = document.getElementById('pointDeleteHint');
    if (state.pointDeleteMode) {
      btn?.classList.add('ring-2', 'ring-orange-300');
      hint?.classList.remove('hidden');
      setupPointDelete();
    } else {
      btn?.classList.remove('ring-2', 'ring-orange-300');
      hint?.classList.add('hidden');
      removePointDelete();
    }
  });
}

function bindPeakInput(inputId: string, callback: (v: number) => void, isInt = false): void {
  const input = document.getElementById(inputId) as HTMLInputElement;
  input?.addEventListener('input', (e) => {
    const value = isInt 
      ? parseInt((e.target as HTMLInputElement).value) 
      : parseFloat((e.target as HTMLInputElement).value);
    if (!isNaN(value)) callback(value);
  });
}

function updateFittingParamPanels(method: FittingMethod): void {
  ['polynomialParams', 'bsplineParams', 'loessParams', 'gaussianParams'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const map: Record<string, string> = { polynomial: 'polynomialParams', bspline: 'bsplineParams', loess: 'loessParams', gaussian: 'gaussianParams' };
  if (map[method]) document.getElementById(map[method])?.classList.remove('hidden');
}

function resetUI(): void {
  ['dataInfo', 'dqdvExport', 'dvdqExport', 'dsocdvExport', 'dqdvPeaksInfo', 'dvdqPeaksInfo'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
  (document.getElementById('performFitting') as HTMLButtonElement).disabled = true;
  (document.getElementById('calculateDqdv') as HTMLButtonElement).disabled = true;
  (document.getElementById('calculateDvdq') as HTMLButtonElement).disabled = true;
  (document.getElementById('calculateDqdi') as HTMLButtonElement).disabled = true;
  (document.getElementById('copyDqdvData') as HTMLButtonElement).disabled = true;
  (document.getElementById('copyDvdqData') as HTMLButtonElement).disabled = true;
  (document.getElementById('copyDsocdvData') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportDqdvExcel') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportDvdqExcel') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportDqdvImage') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportDvdqImage') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportDsocdvImage') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportAllDatasets') as HTMLButtonElement).disabled = true;
  // dQ/dI 按钮状态
  (document.getElementById('copyCurrentCapacityData') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportCurrentCapacityImage') as HTMLButtonElement).disabled = true;
  (document.getElementById('copyDqdiData') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportDqdiImage') as HTMLButtonElement).disabled = true;
  (document.getElementById('copyDidqData') as HTMLButtonElement).disabled = true;
  (document.getElementById('exportDidqImage') as HTMLButtonElement).disabled = true;
  // 销毁所有图表
  ['raw', 'dqdv', 'dvdq', 'dsocdv', 'dqdvQ', 'dqdvSoc', 'dvdqV', 'dvdqSoc', 'dsocdvQ', 'dsocdvSoc', 'dqdi', 'didq', 'currentCapacity'].forEach(k => {
    const chartKey = k as keyof typeof state.charts;
    if (state.charts[chartKey]) {
      (state.charts[chartKey] as Chart | null)?.destroy();
      state.charts[chartKey] = null;
    }
  });
}

// 显示数据信息
function showDataInfo(message: string, isError = false): void {
  const dataInfo = document.getElementById('dataInfo');
  if (dataInfo) {
    dataInfo.classList.remove('hidden');
    dataInfo.innerHTML = `<p class="${isError ? 'text-red-600' : 'text-green-600'}">${message}</p>`;
  }
}

// 解析文本数据并添加数据集（用于批量导入）
function parseDataText(text: string, name: string): boolean {
  try {
    const { voltage, capacity, current } = parseTextData(text);
    const error = validateData(voltage, capacity);
    if (error) throw new Error(error);

    const dataset: Dataset = {
      id: generateId(),
      name: name || `数据集 ${state.datasets.length + 1}`,
      dataType: state.currentDataType,
      voltage,
      capacity,
      current: current && current.length > 0 ? current : undefined,
      color: getNextColor(),
      visible: true,
      fitting: null,
      differential: null,
      directDifferential: null,
      dqdi: null,
      peaks: { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] },
      r2Score: null,
      editedRanges: [],
      originalData: { voltage: [...voltage], capacity: [...capacity] },
    };

    state.datasets.push(dataset);
    state.activeDatasetId = dataset.id;
    return true;
  } catch (err) {
    console.error('解析数据失败:', err);
    return false;
  }
}

// 从文本添加数据集（支持多数据集和横向格式）
function addDatasetsFromText(text: string): void {
  try {
    let datasets: { name: string; voltage: number[]; capacity: number[]; current?: number[]; time?: number[]; cvColumnType?: CVColumnType }[] = [];
    
    console.log('开始解析数据，currentDataType:', state.currentDataType);
    console.log('原始文本前100字符:', text.substring(0, 100));
    
    // 先检测是否是横向数据格式
    if (isHorizontalFormat(text)) {
      console.log('检测为横向格式');
      datasets = parseHorizontalData(text);
    } else {
      console.log('检测为纵向格式');
      // 纵向格式，根据数据类型和充电模式处理
      const splitDatasets = splitMultipleDatasets(text);
      console.log('分割后的数据集数量:', splitDatasets.length);
      
      for (const ds of splitDatasets) {
        try {
          console.log('处理数据集:', ds.name, '数据行数:', ds.data.split('\n').length);
          // 根据数据类型和充电模式解析数据
          if (state.currentDataType === 'charge') {
            const parsedData = parseTextData(ds.data, state.chargeMode, state.cvColumnType, state.cccvColumnType);
            console.log('解析结果:', { voltage: parsedData.voltage.length, capacity: parsedData.capacity.length, current: parsedData.current?.length });
            
            // CV模式特殊处理
            if (state.chargeMode === 'cv') {
              datasets.push({
                name: ds.name,
                voltage: parsedData.voltage,
                capacity: parsedData.capacity,
                current: parsedData.current,
                time: parsedData.time,
                cvColumnType: state.cvColumnType
              });
            } else {
              datasets.push({
                name: ds.name,
                voltage: parsedData.voltage,
                capacity: parsedData.capacity,
                current: parsedData.current,
                time: parsedData.time
              });
            }
          } else {
            // 放电数据
            const parsedData = parseTextData(ds.data);
            console.log('放电数据解析结果:', { voltage: parsedData.voltage.length, capacity: parsedData.capacity.length });
            datasets.push({
              name: ds.name,
              voltage: parsedData.voltage,
              capacity: parsedData.capacity,
              current: parsedData.current
            });
          }
        } catch (e) {
          console.warn(`解析数据集失败: ${ds.name}`, e);
        }
      }
    }
    
    if (datasets.length === 0) {
      showDataInfo('未检测到有效数据', true);
      return;
    }
    
    let successCount = 0;
    const errors: string[] = [];
    
    for (const ds of datasets) {
      try {
        // 根据数据类型和充电模式创建数据集
        if (state.currentDataType === 'charge') {
          if (state.chargeMode === 'cc') {
            // 恒流充电：电压-容量
            const { voltage, capacity } = ds;
            if (voltage.length === 0) {
              throw new Error('恒流充电需要电压-容量数据');
            }
            const error = validateData(voltage, capacity);
            if (error) throw new Error(error);
            
            const dataset: Dataset = {
              id: generateId(),
              name: ds.name || `恒流充电 ${state.datasets.length + 1}`,
              dataType: 'charge',
              chargeMode: 'cc',
              chargePhase: 'cc',
              voltage,
              capacity,
              color: getNextColor(),
              visible: true,
              fitting: null,
              differential: null,
              directDifferential: null,
              dqdi: null,
              peaks: { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] },
              r2Score: null,
              editedRanges: [],
              originalData: { voltage: [...voltage], capacity: [...capacity] },
            };
            state.datasets.push(dataset);
            state.activeDatasetId = dataset.id;
            successCount++;
            
          } else if (state.chargeMode === 'cv') {
            // 恒压充电：电流-容量 或 电流-时间
            const { current, capacity, time, cvColumnType } = ds;
            if (!current || current.length === 0) {
              throw new Error('恒压充电需要电流数据');
            }
            
            // 如果是电流-时间格式，需要从电流和时间计算容量
            let finalCapacity = capacity;
            if (cvColumnType === 'current-time' && time && time.length > 0) {
              // 从电流和时间计算容量：Q = ∫I dt
              // 假设时间单位是秒，电流单位是mA，容量单位是mAh
              finalCapacity = [];
              let cumulativeQ = 0;
              for (let i = 0; i < current.length; i++) {
                if (i === 0) {
                  finalCapacity.push(0);
                } else {
                  // 使用梯形法则计算积分
                  const dt = (time[i] - time[i-1]); // 秒
                  const avgI = (current[i] + current[i-1]) / 2; // mA
                  cumulativeQ += avgI * dt / 3600; // mAh = mA * s / 3600
                  finalCapacity.push(cumulativeQ);
                }
              }
            }
            
            const dataset: Dataset = {
              id: generateId(),
              name: ds.name || `恒压充电 ${state.datasets.length + 1}`,
              dataType: 'charge',
              chargeMode: 'cv',
              chargePhase: 'cv',
              voltage: [], // CV模式没有电压数据
              capacity: finalCapacity,
              current,
              time,
              cvColumnType: cvColumnType || state.cvColumnType,
              // 设置cvData，用于dQ/dI计算
              cvData: {
                voltage: [],
                capacity: [...finalCapacity],
                current: [...current],
                time: time ? [...time] : [],
                startIndex: 0,
                endIndex: current.length - 1
              },
              color: getNextColor(),
              visible: true,
              fitting: null,
              differential: null,
              directDifferential: null,
              dqdi: null,
              peaks: { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] },
              r2Score: null,
              editedRanges: [],
              originalData: { voltage: [], capacity: [...finalCapacity] },
            };
            state.datasets.push(dataset);
            state.activeDatasetId = dataset.id;
            successCount++;
            
          } else if (state.chargeMode === 'cccv') {
            // 恒流恒压充电：电流-电压-容量 或 电流-电压-时间
            const { voltage, capacity, current, time } = ds;
            if (!current || current.length === 0 || voltage.length === 0) {
              throw new Error('CCCV充电需要电流-电压-容量或电流-电压-时间数据');
            }
            
            // 如果是电流-电压-时间格式，需要从电流和时间计算容量
            let finalCapacity = capacity;
            if (state.cccvColumnType === 'current-voltage-time' && time && time.length > 0) {
              finalCapacity = [];
              let cumulativeQ = 0;
              for (let i = 0; i < current.length; i++) {
                if (i === 0) {
                  finalCapacity.push(0);
                } else {
                  const dt = (time[i] - time[i-1]);
                  const avgI = (current[i] + current[i-1]) / 2;
                  cumulativeQ += avgI * dt / 3600;
                  finalCapacity.push(cumulativeQ);
                }
              }
            }
            
            // 自动检测CC/CV阶段
            const phaseResult = detectChargePhases(voltage, current, finalCapacity);
            
            const dataset: Dataset = {
              id: generateId(),
              name: ds.name || `CC-CV充电 ${state.datasets.length + 1}`,
              dataType: 'charge',
              chargeMode: 'cccv',
              chargePhase: phaseResult.phase,
              voltage,
              capacity: finalCapacity,
              current,
              time,
              ccData: phaseResult.ccData,
              cvData: phaseResult.cvData,
              color: getNextColor(),
              visible: true,
              fitting: null,
              differential: null,
              directDifferential: null,
              dqdi: null,
              peaks: { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] },
              r2Score: null,
              editedRanges: [],
              originalData: { voltage: [...voltage], capacity: [...finalCapacity] },
            };
            state.datasets.push(dataset);
            state.activeDatasetId = dataset.id;
            successCount++;
          }
        } else {
          // 放电数据
          const { voltage, capacity } = ds;
          console.log('创建放电数据集:', { name: ds.name, voltageLen: voltage.length, capacityLen: capacity.length });
          if (voltage.length === 0) {
            throw new Error('放电数据需要电压-容量数据');
          }
          const error = validateData(voltage, capacity);
          if (error) {
            console.error('验证数据失败:', error);
            throw new Error(error);
          }

          const dataset: Dataset = {
            id: generateId(),
            name: ds.name || `放电数据 ${state.datasets.length + 1}`,
            dataType: 'discharge',
            voltage,
            capacity,
            color: getNextColor(),
            visible: true,
            fitting: null,
            differential: null,
            directDifferential: null,
            dqdi: null,
            peaks: { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] },
            r2Score: null,
            editedRanges: [],
            originalData: { voltage: [...voltage], capacity: [...capacity] },
          };

          state.datasets.push(dataset);
          state.activeDatasetId = dataset.id;
          successCount++;
          console.log('数据集已添加, total datasets:', state.datasets.length, 'dataset.id:', dataset.id, 'visible:', dataset.visible);
        }
      } catch (e) {
        errors.push(`${ds.name || '数据集'}: ${e instanceof Error ? e.message : '解析失败'}`);
      }
    }
    
    // 清空输入框
    const dataInput = document.getElementById('dataInput') as HTMLTextAreaElement;
    if (dataInput) dataInput.value = '';

    // 更新UI
    console.log('=== addDatasetsFromText 完成 === successCount:', successCount, 'errors:', errors, 'total datasets:', state.datasets.length);
    updateDatasetList();
    updateButtonsState();
    performCalculation('both');
    
    if (successCount > 0) {
      console.log('显示成功消息');
      showDataInfo(`✓ 成功添加 ${successCount} 个数据集${errors.length > 0 ? `，${errors.length} 个失败` : ''}`);
    } else {
      console.log('显示失败消息');
      showDataInfo(`添加失败: ${errors.join('; ')}`, true);
    }
  } catch (e) {
    showDataInfo(`解析失败: ${e instanceof Error ? e.message : '未知错误'}`, true);
  }
}

// 检测是否是横向数据格式（每两列或三列一个数据集）
function isHorizontalFormat(text: string): boolean {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;
  
  // 检查是否有大量的列（>=4列）
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const parts = lines[i].split(/[\t,;]+/).filter(p => p.trim());
    // 只有当列数>=4时才认为是横向格式（至少2个数据集）
    if (parts.length >= 4) return true;
  }
  return false;
}

// 解析横向数据（每两列或三列一个数据集）
function parseHorizontalData(text: string): { name: string; voltage: number[]; capacity: number[]; current?: number[]; time?: number[]; cvColumnType?: CVColumnType }[] {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  
  // 检测分隔符
  let delimiter = '\t';
  const firstLine = lines[0];
  if (firstLine.includes('\t')) {
    delimiter = '\t';
  } else if (firstLine.includes(',')) {
    delimiter = ',';
  } else if (firstLine.includes(';')) {
    delimiter = ';';
  }
  
  // 查找数据起始行（第一行第一个值是数字的行）
  let dataStartRow = 0;
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(delimiter);
    if (parts.length >= 2 && !isNaN(parseFloat(parts[0]))) {
      dataStartRow = i;
      break;
    }
  }
  
  // 检测数据行的实际列数
  const dataLine = lines[dataStartRow];
  const dataParts = dataLine.split(delimiter).map(p => p.trim());
  const actualColCount = dataParts.length;
  
  // 根据当前充电模式确定列数
  let columnsPerDataset = 2;
  if (state.currentDataType === 'charge') {
    if (state.chargeMode === 'cccv') {
      columnsPerDataset = 3;
    } else if (state.chargeMode === 'cv') {
      columnsPerDataset = 2;
    } else {
      // CC模式
      columnsPerDataset = 2;
    }
  }
  
  // 计算数据集数量（基于实际列数）
  const numDatasets = Math.floor(actualColCount / columnsPerDataset);
  
  // 提取数据集名称（从第一行或第二行表头）
  const datasetNames: string[] = [];
  const nameRow = dataStartRow > 0 ? lines[0].split(delimiter).map(p => p.trim()) : [];
  
  for (let i = 0; i < numDatasets; i++) {
    const nameIndex = i * columnsPerDataset;
    let name = nameRow[nameIndex] || `数据集${i + 1}`;
    // 如果表头是数字或为空，使用默认名称
    if (!name || !isNaN(parseFloat(name))) {
      name = `数据集${i + 1}`;
    }
    datasetNames.push(name);
  }
  
  // 收集所有数据
  const datasets: { name: string; voltage: number[]; capacity: number[]; current?: number[]; time?: number[]; cvColumnType?: CVColumnType }[] = [];
  
  for (let d = 0; d < numDatasets; d++) {
    const ds: { name: string; voltage: number[]; capacity: number[]; current?: number[]; time?: number[]; cvColumnType?: CVColumnType } = {
      name: datasetNames[d] || `数据集${d + 1}`,
      voltage: [],
      capacity: []
    };
    
    if (state.currentDataType === 'charge') {
      if (state.chargeMode === 'cccv') {
        ds.current = [];
      } else if (state.chargeMode === 'cv') {
        ds.current = [];
        ds.cvColumnType = state.cvColumnType;
        if (state.cvColumnType === 'current-time') {
          ds.time = [];
        }
      }
    }
    
    datasets.push(ds);
  }
  
  // 解析数据行
  for (let i = dataStartRow; i < lines.length; i++) {
    const parts = lines[i].split(delimiter).map(p => p.trim());
    
    for (let d = 0; d < numDatasets; d++) {
      const baseIndex = d * columnsPerDataset;
      
      if (state.currentDataType === 'charge' && state.chargeMode === 'cccv') {
        // CCCV模式：三列数据
        const v1 = parseFloat(parts[baseIndex]);
        const v2 = parseFloat(parts[baseIndex + 1]);
        const v3 = parseFloat(parts[baseIndex + 2]);
        
        if (!isNaN(v1) && !isNaN(v2) && !isNaN(v3)) {
          // 根据选择的数据列类型解析
          if (state.cccvColumnType === 'current-voltage-capacity') {
            datasets[d].current!.push(v1);
            datasets[d].voltage.push(v2);
            datasets[d].capacity.push(v3);
          } else {
            // current-voltage-time
            datasets[d].current!.push(v1);
            datasets[d].voltage.push(v2);
            if (!datasets[d].time) datasets[d].time = [];
            datasets[d].time!.push(v3);
          }
        }
      } else if (state.currentDataType === 'charge' && state.chargeMode === 'cv') {
        // CV模式：两列数据（电流-容量 或 电流-时间）
        const v1 = parseFloat(parts[baseIndex]);
        const v2 = parseFloat(parts[baseIndex + 1]);
        
        if (!isNaN(v1) && !isNaN(v2)) {
          datasets[d].current!.push(v1);
          if (state.cvColumnType === 'current-capacity') {
            datasets[d].capacity.push(v2);
          } else {
            // current-time
            if (!datasets[d].time) datasets[d].time = [];
            datasets[d].time!.push(v2);
          }
        }
      } else if (state.currentDataType === 'charge' && state.chargeMode === 'cc') {
        // CC模式：电压-容量
        const v = parseFloat(parts[baseIndex]);
        const c = parseFloat(parts[baseIndex + 1]);
        
        if (!isNaN(v) && !isNaN(c)) {
          datasets[d].voltage.push(v);
          datasets[d].capacity.push(c);
        }
      } else {
        // 放电数据：电压-容量
        const v = parseFloat(parts[baseIndex]);
        const c = parseFloat(parts[baseIndex + 1]);
        
        if (!isNaN(v) && !isNaN(c)) {
          datasets[d].voltage.push(v);
          datasets[d].capacity.push(c);
        }
      }
    }
  }
  
  // 不过滤空数据集，保留所有数据集
  return datasets;
}

// 分割多个数据集
function splitMultipleDatasets(text: string): { name: string; data: string }[] {
  const results: { name: string; data: string }[] = [];
  
  // 按空行或分隔符分割
  // 支持格式：
  // 1. 空行分隔
  // 2. # 名称 或 // 名称 作为标题行
  // 3. === 或 --- 作为分隔符
  
  const lines = text.split('\n');
  let currentName = '';
  let currentData: string[] = [];
  let hasData = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // 检测标题行（# 开头或 // 开头）
    if (line.startsWith('#') || line.startsWith('//')) {
      // 保存之前的数据集
      if (hasData && currentData.length > 0) {
        results.push({
          name: currentName || `数据集 ${results.length + 1}`,
          data: currentData.join('\n')
        });
        currentData = [];
        hasData = false;
      }
      // 提取名称
      currentName = line.replace(/^[#\s]+/, '').trim();
      continue;
    }
    
    // 检测分隔符（=== 或 ---）
    if (/^[=-]{3,}$/.test(line)) {
      if (hasData && currentData.length > 0) {
        results.push({
          name: currentName || `数据集 ${results.length + 1}`,
          data: currentData.join('\n')
        });
        currentName = '';
        currentData = [];
        hasData = false;
      }
      continue;
    }
    
    // 空行处理
    if (line === '') {
      if (hasData && currentData.length > 0) {
        // 检查下一行是否是新数据集的开始
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && !nextLine.startsWith('#') && !nextLine.startsWith('//') && !/^[=-]{3,}$/.test(nextLine)) {
          // 检查当前累积的数据是否足够（至少2行有效数据即可）
          const validLines = currentData.filter(l => {
            const parts = l.trim().split(/[,;\t\s]+/);
            return parts.length >= 2 && !isNaN(parseFloat(parts[0]));
          });
          if (validLines.length >= 2) {
            results.push({
              name: currentName || `数据集 ${results.length + 1}`,
              data: currentData.join('\n')
            });
            currentName = '';
            currentData = [];
            hasData = false;
          }
        }
      }
      continue;
    }
    
    // 检查是否是数据行（至少包含一个数字）
    const parts = line.split(/[,;\t\s]+/).filter(p => p.trim());
    if (parts.length >= 2 && !isNaN(parseFloat(parts[0]))) {
      currentData.push(line);
      hasData = true;
    } else if (hasData) {
      // 可能是表头行，也保留
      currentData.push(line);
    }
  }
  
  // 保存最后一个数据集
  if (hasData && currentData.length > 0) {
    results.push({
      name: currentName || `数据集 ${results.length + 1}`,
      data: currentData.join('\n')
    });
  }
  
  return results;
}

// 检测充电阶段（CC/CV）
function detectChargePhases(
  voltage: number[], 
  current: number[], 
  capacity: number[]
): {
  phase: ChargePhase;
  ccData?: { voltage: number[]; capacity: number[]; startIndex: number; endIndex: number };
  cvData?: { voltage: number[]; capacity: number[]; current: number[]; time: number[]; startIndex: number; endIndex: number };
} {
  if (voltage.length < 10) {
    console.log('数据点太少，无法判断');
    return { phase: 'mixed' };
  }
  
  // 计算电压和电流的变化趋势
  const voltageRange = Math.max(...voltage) - Math.min(...voltage);
  const currentRange = Math.max(...current) - Math.min(...current);
  
  console.log('充电阶段检测:', {
    dataLength: voltage.length,
    voltageRange,
    currentRange,
    maxVoltage: Math.max(...voltage),
    minVoltage: Math.min(...voltage),
    maxCurrent: Math.max(...current),
    minCurrent: Math.min(...current)
  });
  
  // 计算前半段和后半段的特征
  const midIndex = Math.floor(voltage.length / 2);
  const firstHalfCurrent = current.slice(0, midIndex);
  const secondHalfCurrent = current.slice(midIndex);
  const firstHalfVoltage = voltage.slice(0, midIndex);
  const secondHalfVoltage = voltage.slice(midIndex);
  
  const firstCurrentMean = firstHalfCurrent.reduce((a, b) => a + b, 0) / firstHalfCurrent.length;
  const secondCurrentMean = secondHalfCurrent.reduce((a, b) => a + b, 0) / secondHalfCurrent.length;
  const firstVoltageRange = Math.max(...firstHalfVoltage) - Math.min(...firstHalfVoltage);
  const secondVoltageRange = Math.max(...secondHalfVoltage) - Math.min(...secondHalfVoltage);
  
  console.log('分段特征:', {
    firstCurrentMean,
    secondCurrentMean,
    firstVoltageRange,
    secondVoltageRange,
    midIndex
  });
  
  // 计算电流衰减比例
  const currentDecayRatio = (firstCurrentMean - secondCurrentMean) / Math.max(Math.abs(firstCurrentMean), 0.001);
  
  // 改进的判断逻辑：
  // 1. 如果后半段电流明显衰减（超过20%），则认为包含CV阶段
  // 2. 如果后半段电压相对稳定（变化小于总范围的50%），也认为包含CV阶段
  const hasCurrentDecay = currentDecayRatio > 0.2;
  const hasVoltageStability = secondVoltageRange < 0.5 * voltageRange;
  
  // CV阶段特征：电流明显衰减 或 电压相对稳定
  const isCV = hasCurrentDecay || hasVoltageStability;
  
  // CC阶段特征：前半段电压变化较大
  const isCC = firstVoltageRange > 0.3 * voltageRange;
  
  console.log('阶段判断:', { 
    hasCurrentDecay, 
    currentDecayRatio,
    hasVoltageStability, 
    isCC, 
    isCV 
  });
  
  if (isCV && isCC) {
    // 混合模式，需要找到CC到CV的转折点
    let transitionIndex = -1;
    
    // 寻找电流开始明显衰减的点
    for (let i = Math.floor(current.length * 0.1); i < current.length - 5; i++) {
      const windowStart = Math.max(0, i - 5);
      const windowEnd = Math.min(current.length - 1, i + 5);
      
      // 检查电流变化
      const currentBefore = current.slice(windowStart, i);
      const currentAfter = current.slice(i, windowEnd);
      const currentChange = (currentBefore.reduce((a, b) => a + b, 0) / currentBefore.length) - 
                           (currentAfter.reduce((a, b) => a + b, 0) / currentAfter.length);
      
      // 检查电压稳定性
      const voltageWindow = voltage.slice(i, windowEnd);
      const voltageVariance = Math.max(...voltageWindow) - Math.min(...voltageWindow);
      
      // 如果电流开始下降（变化超过平均值的10%）
      if (currentChange > 0.1 * firstCurrentMean) {
        transitionIndex = i;
        break;
      }
    }
    
    if (transitionIndex > 0) {
      // 分离CC和CV阶段数据
      const ccData = {
        voltage: voltage.slice(0, transitionIndex),
        capacity: capacity.slice(0, transitionIndex),
        startIndex: 0,
        endIndex: transitionIndex - 1
      };
      
      const cvData = {
        voltage: voltage.slice(transitionIndex),
        capacity: capacity.slice(transitionIndex),
        current: current.slice(transitionIndex),
        time: Array.from({ length: current.length - transitionIndex }, (_, i) => i),
        startIndex: transitionIndex,
        endIndex: current.length - 1
      };
      
      console.log(`检测到CC-CV模式，转折点在索引 ${transitionIndex}，CC段长度: ${ccData.voltage.length}，CV段长度: ${cvData.voltage.length}`);
      return { phase: 'mixed', ccData, cvData };
    }
    
    console.log('检测到可能的CC-CV模式但未找到明确的转折点，使用完整数据作为CV');
    // 即使没有找到明确的转折点，也使用完整数据作为CV数据
    return { 
      phase: 'cv',
      cvData: { 
        voltage, 
        capacity, 
        current, 
        time: Array.from({ length: current.length }, (_, i) => i),
        startIndex: 0, 
        endIndex: voltage.length - 1 
      }
    };
  } else if (isCV) {
    console.log('检测为纯CV模式（电流明显衰减或电压相对稳定）');
    return { 
      phase: 'cv',
      cvData: { 
        voltage, 
        capacity, 
        current, 
        time: Array.from({ length: current.length }, (_, i) => i),
        startIndex: 0, 
        endIndex: voltage.length - 1 
      }
    };
  } else if (isCC) {
    console.log('检测为纯CC模式');
    return { 
      phase: 'cc',
      ccData: { voltage, capacity, startIndex: 0, endIndex: voltage.length - 1 }
    };
  }
  
  // 默认情况下，如果有电流数据，尝试作为CV数据处理
  if (current && current.length > 0) {
    console.log('无法明确判断充电模式，默认使用完整数据作为CV数据');
    return { 
      phase: 'cv',
      cvData: { 
        voltage, 
        capacity, 
        current, 
        time: Array.from({ length: current.length }, (_, i) => i),
        startIndex: 0, 
        endIndex: voltage.length - 1 
      }
    };
  }
  
  console.log('无法判断充电模式，返回mixed');
  return { phase: 'mixed' };
}

// 更新数据集列表UI
function updateDatasetList(): void {
  const listContainer = document.getElementById('datasetList');
  if (!listContainer) return;

  if (state.datasets.length === 0) {
    listContainer.innerHTML = '<div class="text-xs text-gray-400 text-center py-1">点击"添加数据集"导入数据</div>';
    // 隐藏全选控件
    const selectAllControl = document.getElementById('selectAllControl');
    if (selectAllControl) selectAllControl.classList.add('hidden');
    return;
  }

  // 显示全选控件
  const selectAllControl = document.getElementById('selectAllControl');
  if (selectAllControl) selectAllControl.classList.remove('hidden');

  listContainer.innerHTML = state.datasets.map(ds => {
    // 获取数据类型标签
    const dataTypeLabel = ds.dataType === 'charge' ? '⚡' : '🔋';
    // 充电模式标签
    let modeLabel = '';
    if (ds.dataType === 'charge' && ds.chargeMode) {
      if (ds.chargeMode === 'cc') {
        modeLabel = '[CC]';
      } else if (ds.chargeMode === 'cv') {
        modeLabel = '[CV]';
      } else if (ds.chargeMode === 'cccv') {
        modeLabel = ds.chargePhase === 'cc' ? '[CC段]' : ds.chargePhase === 'cv' ? '[CV段]' : '[CC-CV]';
      }
    }
    const isEmpty = ds.dataType === 'charge' && ds.chargeMode === 'cv' ? ds.current?.length === 0 : ds.voltage.length === 0;
    const emptyLabel = isEmpty ? '<span class="text-orange-500 text-[10px]">[空]</span>' : '';
    const pointCount = ds.dataType === 'charge' && ds.chargeMode === 'cv' ? ds.current?.length || 0 : ds.voltage.length;
    
    return `
    <div class="flex items-center gap-1 p-1 rounded text-xs ${ds.id === state.activeDatasetId ? 'bg-blue-50 border border-blue-300' : 'bg-gray-50 hover:bg-gray-100'}" data-id="${ds.id}">
      <input type="checkbox" class="dataset-visible w-3 h-3 accent-blue-500 cursor-pointer" ${ds.visible ? 'checked' : ''} data-id="${ds.id}" title="显示/隐藏">
      <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background-color: ${ds.color}"></span>
      <span class="text-[10px]" title="${ds.dataType === 'charge' ? '充电数据' : '放电数据'}">${dataTypeLabel}</span>
      <span class="flex-1 truncate cursor-pointer dataset-name font-medium" data-id="${ds.id}" title="点击重命名">${ds.name}</span>
      ${emptyLabel}
      <span class="text-gray-400 text-[10px]">${modeLabel}${pointCount}点</span>
      <button class="text-blue-500 hover:text-white hover:bg-blue-500 px-1 py-0.5 rounded dataset-rename transition-colors" data-id="${ds.id}" title="重命名">✏️</button>
      <button class="text-red-500 hover:text-white hover:bg-red-500 px-1 py-0.5 rounded dataset-delete transition-colors" data-id="${ds.id}" title="删除此数据集">🗑️</button>
    </div>
  `}).join('');

  // 更新全选控件状态
  updateSelectAllState();

  // 绑定事件
  listContainer.querySelectorAll('.dataset-visible').forEach(el => {
    el.addEventListener('change', (e) => {
      const id = (e.target as HTMLElement).getAttribute('data-id');
      const dataset = state.datasets.find(ds => ds.id === id);
      if (dataset) {
        dataset.visible = (e.target as HTMLInputElement).checked;
        updateSelectAllState();  // 更新全选状态
        updateCharts('both');
      }
    });
  });

  // 单击选中数据集
  listContainer.querySelectorAll('.dataset-name').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).getAttribute('data-id');
      state.activeDatasetId = id;
      updateDatasetList();
      updateActiveDatasetInfo();
      updatePeaksDisplay();
    });
  });
  
  // 重命名按钮
  listContainer.querySelectorAll('.dataset-rename').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (e.target as HTMLElement).getAttribute('data-id');
      const dataset = state.datasets.find(ds => ds.id === id);
      if (dataset) {
        const newName = prompt('请输入新名称:', dataset.name);
        if (newName && newName.trim()) {
          dataset.name = newName.trim();
          updateDatasetList();
          updateCharts('both'); // 更新图例
        }
      }
    });
  });

  listContainer.querySelectorAll('.dataset-delete').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (e.target as HTMLElement).getAttribute('data-id');
      const dataset = state.datasets.find(ds => ds.id === id);
      if (dataset) {
        // 添加确认提示，避免误删
        if (confirm(`确定要删除数据集 "${dataset.name}" 吗？`)) {
          deleteDataset(id!);
        }
      }
    });
  });
}

// 更新全选控件状态
function updateSelectAllState(): void {
  const selectAllCheckbox = document.getElementById('selectAllDatasets') as HTMLInputElement;
  const datasetCount = document.getElementById('datasetCount');
  
  if (!selectAllCheckbox) return;
  
  const total = state.datasets.length;
  const visibleCount = state.datasets.filter(ds => ds.visible).length;
  
  // 更新复选框状态
  if (visibleCount === 0) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = false;
  } else if (visibleCount === total) {
    selectAllCheckbox.checked = true;
    selectAllCheckbox.indeterminate = false;
  } else {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = true;  // 部分选中状态
  }
  
  // 更新计数显示
  if (datasetCount) {
    datasetCount.textContent = `${visibleCount}/${total} 显示中`;
  }
}

// 全选/取消全选所有数据集
function toggleSelectAll(checked: boolean): void {
  state.datasets.forEach(ds => {
    ds.visible = checked;
  });
  updateDatasetList();
  updateCharts('both');
}

// 删除数据集
function deleteDataset(id: string): void {
  const index = state.datasets.findIndex(ds => ds.id === id);
  if (index === -1) return;

  const deletedName = state.datasets[index].name;
  state.datasets.splice(index, 1);

  // 如果删除的是当前激活的数据集
  if (state.activeDatasetId === id) {
    state.activeDatasetId = state.datasets.length > 0 ? state.datasets[0].id : null;
  }

  updateDatasetList();
  updateButtonsState();
  
  if (state.datasets.length === 0) {
    resetUI();
    showDataInfo('所有数据集已清空');
  } else {
    updateCharts('both');
    updateActiveDatasetInfo();
    showDataInfo(`已删除数据集 "${deletedName}"`);
  }
}

// 更新按钮状态
function updateButtonsState(): void {
  const hasData = state.datasets.length > 0;
  const hasCurrentData = state.datasets.some(ds => ds.current && ds.current.length > 0);
  
  (document.getElementById('performFitting') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('calculateDqdv') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('calculateDvdq') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('calculateDqdi') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDqdvData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDvdqData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDsocdvData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDqdvExcel') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDvdqExcel') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDqdvImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDvdqImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDsocdvImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportAllDatasets') as HTMLButtonElement).disabled = !hasData;
  // 新增曲线按钮状态
  (document.getElementById('copyDqdvQData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDqdvQImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDqdvSocData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDqdvSocImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDvdqVData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDvdqVImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDvdqSocData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDvdqSocImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDsocdvQData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDsocdvQImage') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('copyDsocdvSocData') as HTMLButtonElement).disabled = !hasData;
  (document.getElementById('exportDsocdvSocImage') as HTMLButtonElement).disabled = !hasData;
  // dQ/dI 分析按钮状态
  (document.getElementById('copyCurrentCapacityData') as HTMLButtonElement).disabled = !hasCurrentData;
  (document.getElementById('exportCurrentCapacityImage') as HTMLButtonElement).disabled = !hasCurrentData;
  (document.getElementById('copyDqdiData') as HTMLButtonElement).disabled = !hasCurrentData;
  (document.getElementById('exportDqdiImage') as HTMLButtonElement).disabled = !hasCurrentData;
  (document.getElementById('copyDidqData') as HTMLButtonElement).disabled = !hasCurrentData;
  (document.getElementById('exportDidqImage') as HTMLButtonElement).disabled = !hasCurrentData;
}

// 更新当前激活数据集的信息
function updateActiveDatasetInfo(): void {
  const dataset = getActiveDataset();
  if (dataset && dataset.r2Score) {
    (document.getElementById('r2QV') as HTMLElement).textContent = dataset.r2Score.voltageToCapacity.toFixed(4);
    (document.getElementById('r2VQ') as HTMLElement).textContent = dataset.r2Score.capacityToVoltage.toFixed(4);
  } else {
    (document.getElementById('r2QV') as HTMLElement).textContent = '-';
    (document.getElementById('r2VQ') as HTMLElement).textContent = '-';
  }
}

function bindSlider(sliderId: string, displayId: string, callback: (v: number) => void, isFloat = false): void {
  const slider = document.getElementById(sliderId) as HTMLInputElement;
  const display = document.getElementById(displayId);
  slider?.addEventListener('input', (e) => {
    const value = isFloat ? parseFloat((e.target as HTMLInputElement).value) : parseInt((e.target as HTMLInputElement).value);
    callback(value);
    if (display) display.textContent = isFloat ? value.toFixed(2) : value.toString();
  });
}

function parseTextData(text: string, chargeMode?: ChargeMode, cvColumnType?: CVColumnType, cccvColumnType?: CCCVColumnType): { voltage: number[]; capacity: number[]; current?: number[]; time?: number[] } {
  const lines = text.split('\n').filter(l => l.trim());
  const voltage: number[] = [], capacity: number[] = [], current: number[] = [], time: number[] = [];
  const start = isNaN(parseFloat(lines[0].trim().split(/[,;\t\s]+/)[0])) ? 1 : 0;
  
  console.log('parseTextData: 解析', lines.length, '行数据, 跳过表头行:', start);
  
  // 如果是充电模式，根据具体的模式和列类型解析
  if (chargeMode === 'cv' && cvColumnType) {
    // 恒压充电模式
    for (let i = start; i < lines.length; i++) {
      const parts = lines[i].trim().split(/[,;\t\s]+/).filter(p => p.trim());
      if (parts.length >= 2) {
        const val0 = parseFloat(parts[0]);
        const val1 = parseFloat(parts[1]);
        
        if (!isNaN(val0) && !isNaN(val1)) {
          current.push(val0);
          if (cvColumnType === 'current-capacity') {
            capacity.push(val1);
          } else {
            // current-time: 时间列，后续计算容量
            time.push(val1);
          }
        }
      }
    }
    // CV模式下电压为空数组
    return { voltage: [], capacity, current, time };
  }
  
  if (chargeMode === 'cccv' && cccvColumnType) {
    // 恒流恒压充电模式
    for (let i = start; i < lines.length; i++) {
      const parts = lines[i].trim().split(/[,;\t\s]+/).filter(p => p.trim());
      if (parts.length >= 3) {
        const val0 = parseFloat(parts[0]);
        const val1 = parseFloat(parts[1]);
        const val2 = parseFloat(parts[2]);
        
        if (!isNaN(val0) && !isNaN(val1) && !isNaN(val2)) {
          current.push(val0);
          voltage.push(val1);
          if (cccvColumnType === 'current-voltage-capacity') {
            capacity.push(val2);
          } else {
            // current-voltage-time
            time.push(val2);
          }
        }
      }
    }
    return { voltage, capacity, current, time };
  }
  
  // 默认解析逻辑（放电数据或恒流充电数据）
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].trim().split(/[,;\t\s]+/).filter(p => p.trim());
    if (parts.length >= 3) {
      // 三列数据：电流、电压、容量 或 电压、容量、电流
      // 尝试自动识别列的顺序
      const val0 = parseFloat(parts[0]);
      const val1 = parseFloat(parts[1]);
      const val2 = parseFloat(parts[2]);
      
      if (!isNaN(val0) && !isNaN(val1) && !isNaN(val2)) {
        // 检查哪一列是电压（电压通常在2.5-5.0V范围）
        const isV0Voltage = val0 >= 2.0 && val0 <= 5.0;
        const isV1Voltage = val1 >= 2.0 && val1 <= 5.0;
        
        if (isV1Voltage) {
          // 电流、电压、容量
          current.push(val0);
          voltage.push(val1);
          capacity.push(val2);
        } else if (isV0Voltage) {
          // 电压、容量、电流
          voltage.push(val0);
          capacity.push(val1);
          current.push(val2);
        } else {
          // 无法判断，假设电流、电压、容量
          current.push(val0);
          voltage.push(val1);
          capacity.push(val2);
        }
      }
    } else if (parts.length >= 2) {
      // 两列数据：电压、容量
      const v = parseFloat(parts[0]), c = parseFloat(parts[1]);
      if (!isNaN(v) && !isNaN(c)) { voltage.push(v); capacity.push(c); }
    }
  }
  
  // 返回结果
  if (current.length > 0 && current.length === voltage.length) {
    return { voltage, capacity, current };
  }
  return { voltage, capacity };
}

/**
 * 仅执行拟合后差分
 */
function performFittingOnly(): void {
  try {
    // 计算所有可见的数据集
    state.datasets.forEach(dataset => {
      if (!dataset.visible) return;
      
      // CV模式不需要拟合
      if (dataset.dataType === 'charge' && dataset.chargeMode === 'cv') {
        return;
      }
      
      // 拟合后差分模式：先拟合，再对拟合曲线求导
      dataset.differential = calculateDifferential(dataset.voltage, dataset.capacity, state.fittingParams, state.diffParams);
      dataset.directDifferential = null;
      
      // 同时更新 fitting 引用（用于兼容旧代码）
      dataset.fitting = {
        voltage: dataset.differential.voltage,
        capacity: dataset.differential.capacity,
        fittedVoltage: dataset.differential.fittedVoltage,
        fittedCapacity: dataset.differential.fittedCapacity,
        uniformVoltage: dataset.differential.uniformVoltage,
        uniformCapacity: dataset.differential.uniformCapacity
      };
      
      // 计算R²分数
      const fC = getFittedValues(dataset.differential.fittedVoltage, dataset.differential.fittedCapacity, dataset.voltage);
      const fV = getFittedValues(dataset.differential.fittedCapacity, dataset.differential.fittedVoltage, dataset.capacity);
      dataset.r2Score = { 
        voltageToCapacity: calculateR2(dataset.capacity, fC), 
        capacityToVoltage: calculateR2(dataset.voltage, fV) 
      };
      showDataInfo(`✓ 拟合完成，使用了 ${state.fittingParams.method} 方法`);
    });

    // 更新 R² 显示（显示当前激活的数据集）
    updateActiveDatasetInfo();
    
    // 启用按钮
    updateButtonsState();
    
    // 更新所有图表
    updateCharts('both');
  } catch (error) {
    showDataInfo(`拟合失败: ${error instanceof Error ? error.message : '未知错误'}`, true);
  }
}

/**
 * 仅执行直接差分
 */
function performDirectDifferentialOnly(): void {
  try {
    // 计算所有可见的数据集
    state.datasets.forEach(dataset => {
      if (!dataset.visible) return;
      
      // CV模式不需要直接差分
      if (dataset.dataType === 'charge' && dataset.chargeMode === 'cv') {
        return;
      }
      
      // 直接差分模式：先直接差分，再拟合差分曲线
      dataset.directDifferential = calculateDirectDifferential(
        dataset.voltage,
        dataset.capacity,
        state.directDiffParams,
        state.diffCurveFittingParams
      );
      dataset.differential = null;
      dataset.fitting = null;
      dataset.r2Score = null;
      showDataInfo(`✓ 直接差分完成，差分曲线使用 ${state.diffCurveFittingParams.method} 拟合`);
    });

    // 启用按钮
    updateButtonsState();
    
    // 更新所有图表
    updateCharts('both');
  } catch (error) {
    showDataInfo(`直接差分失败: ${error instanceof Error ? error.message : '未知错误'}`, true);
  }
}

function performCalculation(type: 'dqdv' | 'dvdq' | 'both'): void {
  console.log('performCalculation called, type:', type, 'datasets count:', state.datasets.length, 'diffMode:', state.diffMode);
  try {
    // 计算所有可见的数据集
    state.datasets.forEach(dataset => {
      console.log('Processing dataset:', dataset.id, 'visible:', dataset.visible);
      if (!dataset.visible) return;
      
      // 根据数据类型和充电模式决定计算哪些曲线
      if (dataset.dataType === 'charge') {
        if (dataset.chargeMode === 'cc') {
          // 纯CC模式：计算dQ/dV、dV/dQ
          if (state.diffMode === 'direct') {
            // 直接差分模式
            dataset.directDifferential = calculateDirectDifferential(
              dataset.voltage,
              dataset.capacity,
              state.directDiffParams,
              state.diffCurveFittingParams
            );
            dataset.differential = null; // 清除拟合后差分结果
          } else {
            // 拟合后差分模式（默认）
            dataset.differential = calculateDifferential(dataset.voltage, dataset.capacity, state.fittingParams, state.diffParams);
            dataset.directDifferential = null; // 清除直接差分结果
          }
          // 计算 R²（仅在拟合后差分模式下）
          if (dataset.differential) {
            const fC = getFittedValues(dataset.differential.fittedVoltage, dataset.differential.fittedCapacity, dataset.voltage);
            const fV = getFittedValues(dataset.differential.fittedCapacity, dataset.differential.fittedVoltage, dataset.capacity);
            dataset.r2Score = { voltageToCapacity: calculateR2(dataset.capacity, fC), capacityToVoltage: calculateR2(dataset.voltage, fV) };
            dataset.fitting = {
              voltage: dataset.differential.voltage,
              capacity: dataset.differential.capacity,
              fittedVoltage: dataset.differential.fittedVoltage,
              fittedCapacity: dataset.differential.fittedCapacity,
              uniformVoltage: dataset.differential.uniformVoltage,
              uniformCapacity: dataset.differential.uniformCapacity
            };
          } else {
            dataset.r2Score = null;
            dataset.fitting = null;
          }
        } else if (dataset.chargeMode === 'cv') {
          // 纯CV模式：只计算dQ/dI
          if (dataset.current && dataset.current.length > 0) {
            dataset.dqdi = calculateDqdiFromCurrentCapacity(
              dataset.current,
              dataset.capacity,
              state.dqdiParams,
              state.fittingParams
            );
          }
        } else if (dataset.chargeMode === 'cccv') {
          // CCCV模式：根据阶段分别处理
          if (dataset.chargePhase === 'cc' || dataset.chargePhase === 'mixed') {
            // CC阶段：计算dQ/dV、dV/dQ
            const dataToUse = dataset.ccData ? dataset.ccData : { voltage: dataset.voltage, capacity: dataset.capacity };
            if (state.diffMode === 'direct') {
              dataset.directDifferential = calculateDirectDifferential(
                dataToUse.voltage,
                dataToUse.capacity,
                state.directDiffParams,
                state.diffCurveFittingParams
              );
              dataset.differential = null;
            } else {
              dataset.differential = calculateDifferential(dataToUse.voltage, dataToUse.capacity, state.fittingParams, state.diffParams);
              dataset.directDifferential = null;
            }
            if (dataset.differential) {
              const fC = getFittedValues(dataset.differential.fittedVoltage, dataset.differential.fittedCapacity, dataToUse.voltage);
              const fV = getFittedValues(dataset.differential.fittedCapacity, dataset.differential.fittedVoltage, dataToUse.capacity);
              dataset.r2Score = { voltageToCapacity: calculateR2(dataToUse.capacity, fC), capacityToVoltage: calculateR2(dataToUse.voltage, fV) };
            }
          }
          
          if (dataset.cvData && dataset.cvData.current.length > 0) {
            // CV阶段：计算dQ/dI
            dataset.dqdi = calculateDqdiFromCurrentCapacity(
              dataset.cvData.current,
              dataset.cvData.capacity,
              state.dqdiParams,
              state.fittingParams
            );
          }
        }
      } else {
        // 放电数据：计算dQ/dV、dV/dQ
        if (state.diffMode === 'direct') {
          // 直接差分模式
          dataset.directDifferential = calculateDirectDifferential(
            dataset.voltage,
            dataset.capacity,
            state.directDiffParams,
            state.diffCurveFittingParams
          );
          dataset.differential = null; // 清除拟合后差分结果
        } else {
          // 拟合后差分模式（默认）
          dataset.differential = calculateDifferential(dataset.voltage, dataset.capacity, state.fittingParams, state.diffParams);
          dataset.directDifferential = null; // 清除直接差分结果
        }
        // 计算 R²（仅在拟合后差分模式下）
        if (dataset.differential) {
          const fC = getFittedValues(dataset.differential.fittedVoltage, dataset.differential.fittedCapacity, dataset.voltage);
          const fV = getFittedValues(dataset.differential.fittedCapacity, dataset.differential.fittedVoltage, dataset.capacity);
          dataset.r2Score = { voltageToCapacity: calculateR2(dataset.capacity, fC), capacityToVoltage: calculateR2(dataset.voltage, fV) };
          dataset.fitting = {
            voltage: dataset.differential.voltage,
            capacity: dataset.differential.capacity,
            fittedVoltage: dataset.differential.fittedVoltage,
            fittedCapacity: dataset.differential.fittedCapacity,
            uniformVoltage: dataset.differential.uniformVoltage,
            uniformCapacity: dataset.differential.uniformCapacity
          };
        } else {
          dataset.r2Score = null;
          dataset.fitting = null;
        }
      }
    });

    // 更新 R² 显示（显示当前激活的数据集）
    updateActiveDatasetInfo();
    
    // 启用按钮
    updateButtonsState();
    
    updateCharts(type);
  } catch (error) {
    showDataInfo(`计算失败: ${error instanceof Error ? error.message : '未知错误'}`, true);
  }
}

/**
 * 执行 dQ/dI 计算（恒压充电模式）
 * 需要数据集包含电流数据
 */
function performDqdiCalculation(): void {
  try {
    let hasCurrentData = false;
    let processedCount = 0;
    
    console.log('开始dQ/dI计算，数据集数量:', state.datasets.length);
    
    state.datasets.forEach(dataset => {
      if (!dataset.visible) return;
      
      console.log(`处理数据集 "${dataset.name}":`, {
        hasCurrent: !!dataset.current && dataset.current.length,
        currentLength: dataset.current?.length,
        hasCvData: !!dataset.cvData,
        cvDataLength: dataset.cvData?.current?.length,
        hasTime: !!dataset.time && dataset.time.length,
        timeLength: dataset.time?.length,
        chargeMode: dataset.chargeMode,
        chargePhase: dataset.chargePhase
      });
      
      // 检查是否有CV阶段数据
      if (dataset.cvData && dataset.cvData.current.length > 0) {
        hasCurrentData = true;
        processedCount++;
        try {
          console.log(`使用CV数据进行dQ/dI计算（稳健算法），数据点数: ${dataset.cvData.current.length}`);
          // 使用新的稳健dQ/dI计算方法
          dataset.dqdi = calculateDqdiRobust(
            dataset.cvData.current,
            dataset.cvData.capacity,
            state.dqdiParams,
            state.fittingParams
          );
          console.log(`数据集 "${dataset.name}" dQ/dI计算成功，结果数据点数:`, dataset.dqdi?.dqdiCurrent?.length);
        } catch (err) {
          console.error(`数据集 "${dataset.name}" dQ/dI 计算失败:`, err);
          showDataInfo(`数据集 "${dataset.name}" dQ/dI 计算失败: ${err instanceof Error ? err.message : '未知错误'}`, true);
        }
      } else if (dataset.current && dataset.current.length > 0) {
        // 如果没有分离的CV数据，但有电流数据，尝试使用稳健算法
        hasCurrentData = true;
        processedCount++;
        try {
          console.log(`使用原始数据进行dQ/dI计算（稳健算法），数据点数: ${dataset.current.length}`);
          // 确保有time数组
          const timeArray = dataset.time && dataset.time.length > 0 ? dataset.time : undefined;
          console.log('使用time数组:', timeArray ? `长度${timeArray.length}` : '使用索引');
          
          // 使用稳健算法处理完整数据
          dataset.dqdi = calculateDqdiRobust(
            dataset.current,
            dataset.capacity,
            state.dqdiParams,
            state.fittingParams
          );
          
          console.log(`数据集 "${dataset.name}" dQ/dI计算成功，结果数据点数:`, dataset.dqdi?.dqdiCurrent?.length);
        } catch (err) {
          console.error(`数据集 "${dataset.name}" dQ/dI 计算失败:`, err);
          showDataInfo(`数据集 "${dataset.name}" dQ/dI 计算失败: ${err instanceof Error ? err.message : '未知错误'}`, true);
        }
      } else if (dataset.voltage && dataset.capacity) {
        showDataInfo(`数据集 "${dataset.name}" 缺少电流数据，dQ/dI 分析需要恒压充电模式的电流数据`, true);
      }
    });

    if (!hasCurrentData) {
      showDataInfo('请导入包含电流数据的充电数据', true);
      return;
    }

    if (processedCount === 0) {
      showDataInfo('没有可处理的数据集，请确保数据包含电流信息', true);
      return;
    }

    console.log(`dQ/dI计算完成，准备更新图表，处理了 ${processedCount} 个数据集`);
    
    // 计算并显示恒压阶段特征常数
    state.datasets.forEach(dataset => {
      if (!dataset.visible || !dataset.dqdi) return;
      
      try {
        const currentToUse = dataset.cvData?.current || dataset.current;
        const capacityToUse = dataset.cvData?.capacity || dataset.capacity;
        const voltageToUse = dataset.voltage;
        const timeToUse = dataset.cvData?.time || dataset.time;
        
        if (currentToUse && capacityToUse && currentToUse.length > 0) {
          const characteristics = calculateCVCharacteristics(
            currentToUse,
            capacityToUse,
            voltageToUse,
            timeToUse
          );
          
          // 显示特征常数
          console.log(`\n=== 数据集 "${dataset.name}" 恒压阶段特征常数 ===`);
          console.log(`初始电流: ${characteristics.initialCurrent.toFixed(2)} A`);
          console.log(`最终电流: ${characteristics.finalCurrent.toFixed(2)} A`);
          console.log(`容量增量: ${characteristics.capacityGain.toFixed(2)} Ah`);
          console.log(`CV持续时间: ${(characteristics.cvDuration / 3600).toFixed(2)} h`);
          console.log(`时间常数: ${(characteristics.timeConstant / 3600).toFixed(2)} h`);
          console.log(`衰减率: ${characteristics.decayRate.toFixed(6)} /s`);
          console.log(`dQ/dI 最大值: ${characteristics.dqdiMax.toFixed(4)} Ah/A`);
          console.log(`dQ/dI 平均值: ${characteristics.dqdiMean.toFixed(4)} Ah/A`);
          console.log(`dI/dQ 峰值: ${characteristics.didqPeak.toFixed(4)} A/Ah`);
          console.log(`拟合优度 R²: ${characteristics.r2Score.toFixed(4)}`);
          console.log(`分离指数: ${characteristics.separationIndex.toFixed(4)}`);
          
          // 在界面上显示
          showCharacteristicsInfo(dataset.name, characteristics);
        }
      } catch (err) {
        console.error(`计算特征常数失败:`, err);
      }
    });
    
    updateDqdiCharts();
    showDataInfo(`✓ dQ/dI 计算完成，处理了 ${processedCount} 个数据集`);
  } catch (error) {
    console.error('dQ/dI 计算错误:', error);
    showDataInfo(`dQ/dI 计算失败: ${error instanceof Error ? error.message : '未知错误'}`, true);
  }
}

/**
 * 显示特征常数信息
 */
function showCharacteristicsInfo(datasetName: string, chars: CVCharacteristics): void {
  const infoDiv = document.getElementById('characteristicsInfo');
  if (!infoDiv) return;
  
  const info = `
    <div class="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
      <h4 class="text-sm font-semibold text-green-800 mb-2">📊 ${datasetName} - 恒压阶段特征常数</h4>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div><span class="text-gray-600">初始电流:</span> ${chars.initialCurrent.toFixed(2)} A</div>
        <div><span class="text-gray-600">最终电流:</span> ${chars.finalCurrent.toFixed(2)} A</div>
        <div><span class="text-gray-600">容量增量:</span> ${chars.capacityGain.toFixed(2)} Ah</div>
        <div><span class="text-gray-600">CV持续时间:</span> ${(chars.cvDuration / 3600).toFixed(2)} h</div>
        <div><span class="text-gray-600">时间常数:</span> ${(chars.timeConstant / 3600).toFixed(2)} h</div>
        <div><span class="text-gray-600">衰减率:</span> ${chars.decayRate.toFixed(6)} /s</div>
        <div><span class="text-gray-600">dQ/dI 最大:</span> ${chars.dqdiMax.toFixed(4)} Ah/A</div>
        <div><span class="text-gray-600">dQ/dI 平均:</span> ${chars.dqdiMean.toFixed(4)} Ah/A</div>
        <div><span class="text-gray-600">dI/dQ 峰值:</span> ${chars.didqPeak.toFixed(4)} A/Ah</div>
        <div><span class="text-gray-600">拟合优度 R²:</span> ${chars.r2Score.toFixed(4)}</div>
        <div class="col-span-2"><span class="text-gray-600">分离指数:</span> ${chars.separationIndex.toFixed(4)}</div>
      </div>
    </div>
  `;
  
  infoDiv.innerHTML = info;
}

function getFittedValues(xFit: number[], yFit: number[], xOrig: number[]): number[] {
  return xOrig.map(x => {
    let l = 0, r = xFit.length - 1;
    if (x <= xFit[0]) return yFit[0];
    if (x >= xFit[r]) return yFit[r];
    while (r - l > 1) { const m = Math.floor((l + r) / 2); if (xFit[m] <= x) l = m; else r = m; }
    const t = (x - xFit[l]) / (xFit[r] - xFit[l]);
    return yFit[l] + t * (yFit[r] - yFit[l]);
  });
}

function updateCharts(type: 'dqdv' | 'dvdq' | 'both'): void {
  // 获取所有可见的数据集（不只是有differential的）
  const visibleDatasets = state.datasets.filter(ds => ds.visible);
  console.log('updateCharts called, type:', type, 'visibleDatasets:', visibleDatasets.length, 'diffMode:', state.diffMode);
  
  // 原始曲线图表：显示所有可见数据集
  updateRawChart(visibleDatasets);
  
  // 差分图表：根据 diffMode 选择显示哪种差分结果
  let datasetsWithResults: Dataset[] = [];
  
  if (state.diffMode === 'direct') {
    // 直接差分模式：显示有 directDifferential 的数据集
    datasetsWithResults = visibleDatasets.filter(ds => ds.directDifferential);
  } else {
    // 拟合后差分模式：显示有 differential 的数据集
    datasetsWithResults = visibleDatasets.filter(ds => ds.differential);
  }
  
  if (type === 'dqdv' || type === 'both') {
    updateDqdvChart(datasetsWithResults);
    detectAndShowPeaks('dqdv');
  }
  if (type === 'dvdq' || type === 'both') {
    updateDvdqChart(datasetsWithResults);
    detectAndShowPeaks('dvdq');
  }
  // dSOC/dV 始终更新（依赖于 dQ/dV）
  updateDsocdvChart(datasetsWithResults);
  
  // 更新新增曲线图表
  updateDqdvQChart(datasetsWithResults);
  updateDqdvSocChart(datasetsWithResults);
  updateDvdqVChart(datasetsWithResults);
  updateDvdqSocChart(datasetsWithResults);
  updateDsocdvQChart(datasetsWithResults);
  updateDsocdvSocChart(datasetsWithResults);
  updateVSocChart(datasetsWithResults);
}

function updateRawChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('rawChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.raw) state.charts.raw.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 为每个数据集创建数据系列
  const chartDatasets: any[] = [];
  datasets.forEach(ds => {
    // 根据数据类型和充电模式决定显示什么曲线
    if (ds.dataType === 'charge' && ds.chargeMode === 'cv') {
      // CV模式：显示电流-容量曲线
      if (ds.current && ds.current.length > 0) {
        chartDatasets.push({
          label: `${ds.name} (原始)`,
          data: ds.capacity.map((c, i) => ({ x: c, y: ds.current![i] })),
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.5)'),
          pointRadius: 3,
          type: 'scatter',
        });
      }
    } else {
      // 其他模式：显示电压-容量曲线
      chartDatasets.push({
        label: `${ds.name} (原始)`,
        data: ds.capacity.map((c, i) => ({ x: c, y: ds.voltage[i] })),
        backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.5)'),
        pointRadius: 3,
        type: 'scatter',
      });
      // 拟合曲线（优先使用独立的拟合结果）
      // 使用 uniformCapacity 和 fittedVoltage，确保与原始数据坐标一致（x=容量, y=电压）
      const fittingData = ds.fitting || ds.differential;
      if (fittingData) {
        chartDatasets.push({
          label: `${ds.name} (拟合)`,
          data: fittingData.uniformCapacity.map((c: number, i: number) => ({ x: c, y: fittingData.fittedVoltage[i] })),
          borderColor: ds.color,
          type: 'line' as const,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.3,
        });
      }
    }
    
    // 显示编辑区域（标注颜色的区域）
    ds.editedRanges.forEach((range, idx) => {
      if (range.action === 'colored' && range.color) {
        // 找到对应的容量范围
        const startCapacity = ds.originalData?.capacity[range.startIndex];
        const endCapacity = ds.originalData?.capacity[range.endIndex];
        
        if (startCapacity !== undefined && endCapacity !== undefined) {
          chartDatasets.push({
            label: `${ds.name} 标注${idx + 1}`,
            data: [
              { x: startCapacity, y: range.xStart },
              { x: endCapacity, y: range.xStart },
              { x: endCapacity, y: range.xEnd },
              { x: startCapacity, y: range.xEnd },
              { x: startCapacity, y: range.xStart },
            ],
            backgroundColor: range.color + '40', // 添加透明度
            borderColor: range.color,
            borderWidth: 2,
            fill: true,
            showLine: true,
            pointRadius: 0,
            order: 0,
          });
        }
      }
    });
  });

  // 判断是否有CV模式的数据，决定坐标轴标签
  const hasCVData = datasets.some(ds => ds.dataType === 'charge' && ds.chargeMode === 'cv');
  const yAxisLabel = hasCVData ? '电流 (mA)' : '电压 (V)';

  state.charts.raw = new Chart(ctx, {
    type: 'scatter',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '容量 (Ah)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: yAxisLabel, font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDqdvChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dqdvChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dqdv) state.charts.dqdv.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式：显示拟合后的差分曲线
      const dd = ds.directDifferential;
      
      // 优先使用拟合后的数据
      if (dd.fittedDqdv && dd.fittedDqdv.voltage.length > 0 && dd.fittedDqdv.dqdv.length > 0) {
        const data = dd.fittedDqdv.voltage.map((v, i) => ({ x: v, y: dd.fittedDqdv!.dqdv[i] })).filter((p: { x: number; y: number }) => isFinite(p.y));
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分-拟合)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
      // 如果拟合数据为空或不足，显示原始差分数据
      if (chartDatasets.length === 0 && dd.rawDqdv && dd.rawDqdv.voltage.length > 0 && dd.rawDqdv.dqdv.length > 0) {
        const rawData = dd.rawDqdv.voltage.map((v, i) => ({ x: v, y: dd.rawDqdv!.dqdv[i] })).filter((p: { x: number; y: number }) => isFinite(p.y));
        if (rawData.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (原始差分)`,
            data: rawData,
            borderColor: ds.color,
            borderWidth: 1,
            pointRadius: 2,
            fill: false,
            tension: 0,
            borderDash: [5, 5],
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      const voltageData = ds.differential.dqdvVoltage || ds.differential.fittedVoltage;
      const data = voltageData.map((v: number, i: number) => ({ x: v, y: ds.differential!.dqdv[i] })).filter((p: { x: number; y: number }) => isFinite(p.y));
      chartDatasets.push({
        label: ds.name,
        data,
        borderColor: ds.color,
        backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      });
    }
    
    // 显示标注颜色的区域
    ds.editedRanges.filter(r => r.chartType === 'dqdv' && r.action === 'colored').forEach((range, idx) => {
      if (range.color && range.yStart !== undefined && range.yEnd !== undefined) {
        chartDatasets.push({
          label: `${ds.name} 标注${idx + 1}`,
          data: [
            { x: range.xStart, y: range.yEnd },
            { x: range.xEnd, y: range.yEnd },
            { x: range.xEnd, y: range.yStart },
            { x: range.xStart, y: range.yStart },
            { x: range.xStart, y: range.yEnd },
          ],
          backgroundColor: range.color + '40',
          borderColor: range.color,
          borderWidth: 2,
          fill: true,
          showLine: true,
          pointRadius: 0,
          order: 0,
        });
      }
    });
  });

  state.charts.dqdv = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '电压 (V)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dQ/dV (Ah/V)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDvdqChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dvdqChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dvdq) state.charts.dvdq.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式：显示拟合后的差分曲线
      const dd = ds.directDifferential;
      
      // 优先使用拟合后的数据
      if (dd.fittedDvdq && dd.fittedDvdq.capacity.length > 0 && dd.fittedDvdq.dvdq.length > 0) {
        const data = dd.fittedDvdq.capacity.map((c, i) => ({ x: c, y: dd.fittedDvdq!.dvdq[i] })).filter((p: { x: number; y: number }) => isFinite(p.y));
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分-拟合)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
      // 如果拟合数据为空或不足，显示原始差分数据
      if (chartDatasets.length === 0 && dd.rawDvdq && dd.rawDvdq.capacity.length > 0 && dd.rawDvdq.dvdq.length > 0) {
        const rawData = dd.rawDvdq.capacity.map((c, i) => ({ x: c, y: dd.rawDvdq!.dvdq[i] })).filter((p: { x: number; y: number }) => isFinite(p.y));
        if (rawData.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (原始差分)`,
            data: rawData,
            borderColor: ds.color,
            borderWidth: 1,
            pointRadius: 2,
            fill: false,
            tension: 0,
            borderDash: [5, 5],
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      const capacityData = ds.differential.dvdqCapacity || ds.differential.fittedCapacity;
      const data = capacityData.map((c: number, i: number) => ({ x: c, y: ds.differential!.dvdq[i] })).filter((p: { x: number; y: number }) => isFinite(p.y));
      chartDatasets.push({
        label: ds.name,
        data,
        borderColor: ds.color,
        backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      });
    }
    
    // 显示标注颜色的区域
    ds.editedRanges.filter(r => r.chartType === 'dvdq' && r.action === 'colored').forEach((range, idx) => {
      if (range.color && range.yStart !== undefined && range.yEnd !== undefined) {
        chartDatasets.push({
          label: `${ds.name} 标注${idx + 1}`,
          data: [
            { x: range.xStart, y: range.yEnd },
            { x: range.xEnd, y: range.yEnd },
            { x: range.xEnd, y: range.yStart },
            { x: range.xStart, y: range.yStart },
            { x: range.xStart, y: range.yEnd },
          ],
          backgroundColor: range.color + '40',
          borderColor: range.color,
          borderWidth: 2,
          fill: true,
          showLine: true,
          pointRadius: 0,
          order: 0,
        });
      }
    });
  });

  state.charts.dvdq = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '容量 (Ah)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dV/dQ (V/Ah)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDsocdvChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dsocdvChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dsocdv) state.charts.dsocdv.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  const peakInfoArr: { name: string; maxPeak: number; maxPeakVoltage: number; peak045: number; ratio: string }[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式
      const dd = ds.directDifferential;
      
      // 优先使用 fittedDqdv.voltage 和 dsocdv
      if (dd.fittedDqdv && dd.fittedDqdv.voltage.length > 0 && dd.dsocdv && dd.dsocdv.length > 0) {
        // 确保长度匹配
        const minLen = Math.min(dd.fittedDqdv.voltage.length, dd.dsocdv.length);
        const data = [];
        for (let i = 0; i < minLen; i++) {
          if (isFinite(dd.fittedDqdv.voltage[i]) && isFinite(dd.dsocdv[i])) {
            data.push({ x: dd.fittedDqdv.voltage[i], y: dd.dsocdv[i] });
          }
        }
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
          // 计算峰值
          computeDsocdvPeaks(data, ds.name, peakInfoArr);
        }
      }
      // 如果 dsocdv 数据为空，尝试从 rawDqdv 计算
      if (chartDatasets.length === 0 && dd.rawDqdv && dd.rawDqdv.voltage.length > 0 && dd.rawDqdv.dqdv.length > 0) {
        // 从原始数据计算 dSOC/dV
        const maxCap = Math.max(...dd.rawDqdv.dqdv.map(Math.abs)) || 1;
        const data = dd.rawDqdv.voltage.map((v, i) => ({ x: v, y: dd.rawDqdv!.dqdv[i] / maxCap })).filter((p: { x: number; y: number }) => isFinite(p.y));
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (原始差分)`,
            data,
            borderColor: ds.color,
            borderWidth: 1,
            pointRadius: 2,
            fill: false,
            tension: 0,
            borderDash: [5, 5],
          });
          // 计算峰值
          computeDsocdvPeaks(data, ds.name, peakInfoArr);
        }
      }
    } else if (ds.differential && ds.differential.dsocdv) {
      // 拟合后差分模式
      // 使用与 dQ/dV 相同的电压数组
      const voltageData = ds.differential.dqdvVoltage || ds.differential.uniformVoltage;
      console.log(`[dsocdv] dataset: ${ds.name}`);
      console.log(`[dsocdv] voltageData length: ${voltageData.length}`);
      console.log(`[dsocdv] dsocdv length: ${ds.differential.dsocdv.length}`);
      console.log(`[dsocdv] dsocdv sample: ${ds.differential.dsocdv.slice(0, 5)}`);
      // 确保 dsocdv 和 voltageData 长度匹配
      const minLen = Math.min(voltageData.length, ds.differential.dsocdv.length);
      const data = [];
      for (let i = 0; i < minLen; i++) {
        if (isFinite(voltageData[i]) && isFinite(ds.differential.dsocdv[i])) {
          data.push({ x: voltageData[i], y: ds.differential.dsocdv[i] });
        }
      }
      console.log('updateDsocdvChart: data points:', data.length, 'minLen:', minLen);
      if (data.length > 0) {
        chartDatasets.push({
          label: ds.name,
          data,
          borderColor: ds.color,
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        });
        // 计算峰值
        computeDsocdvPeaks(data, ds.name, peakInfoArr);
      }
    }
  });

  state.charts.dsocdv = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '电压 (V)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dSOC/dV (1/V)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });

  // 更新峰值信息展示
  updateDsocdvPeakDisplay(peakInfoArr);
}

/** 计算 dSOC/dV 曲线的 0.45V 峰值和最高峰值 */
function computeDsocdvPeaks(
  data: { x: number; y: number }[],
  name: string,
  peakInfoArr: { name: string; maxPeak: number; maxPeakVoltage: number; peak045: number; ratio: string }[]
): void {
  if (data.length === 0) return;

  // 找最高峰值（dSOC/dV 最大值）
  let maxPeak = -Infinity;
  let maxPeakVoltage = 0;
  for (const p of data) {
    if (p.y > maxPeak) {
      maxPeak = p.y;
      maxPeakVoltage = p.x;
    }
  }

  // 找 0.45V 附近的峰值：在 0.44V ~ 0.46V 范围内找最大值
  // 如果没有精确的 0.45V 数据点，使用线性插值获取 0.45V 处的值
  let peak045 = 0;
  const targetV = 0.45;
  const tolerance = 0.01; // 1mV 容差用于直接匹配

  // 先尝试在 0.44-0.46 范围内找峰值
  let nearbyMax = -Infinity;
  let hasNearby = false;
  for (const p of data) {
    if (p.x >= 0.44 && p.x <= 0.46) {
      hasNearby = true;
      if (p.y > nearbyMax) {
        nearbyMax = p.y;
      }
    }
  }

  if (hasNearby) {
    peak045 = nearbyMax;
  } else {
    // 数据中无 0.44-0.46V 范围的点，尝试线性插值获取 0.45V 处的值
    // 按电压排序
    const sorted = [...data].sort((a, b) => a.x - b.x);
    // 找到 0.45V 两侧的点
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].x <= targetV && sorted[i + 1].x >= targetV) {
        // 线性插值
        const t = (targetV - sorted[i].x) / (sorted[i + 1].x - sorted[i].x);
        peak045 = sorted[i].y + t * (sorted[i + 1].y - sorted[i].y);
        break;
      }
    }
  }

  // 计算比值
  const ratio = maxPeak > 0 ? (peak045 / maxPeak) : 0;

  peakInfoArr.push({
    name,
    maxPeak,
    maxPeakVoltage,
    peak045,
    ratio: isFinite(ratio) ? ratio.toFixed(4) : 'N/A',
  });
}

/** 更新 dSOC/dV 峰值信息展示 */
function updateDsocdvPeakDisplay(
  peakInfoArr: { name: string; maxPeak: number; maxPeakVoltage: number; peak045: number; ratio: string }[]
): void {
  const peakInfoEl = document.getElementById('dsocdvPeakInfo');
  const tbody = document.getElementById('dsocdvPeakTableBody');
  if (!peakInfoEl || !tbody) return;

  if (peakInfoArr.length === 0) {
    peakInfoEl.classList.add('hidden');
    return;
  }

  peakInfoEl.classList.remove('hidden');
  tbody.innerHTML = '';
  for (const info of peakInfoArr) {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-orange-100';
    tr.innerHTML = `
      <td class="py-0.5 font-medium">${info.name}</td>
      <td class="py-0.5">${info.maxPeak.toFixed(4)}<br/><span class="text-gray-400">(${info.maxPeakVoltage.toFixed(3)}V)</span></td>
      <td class="py-0.5">${info.peak045.toFixed(4)}</td>
      <td class="py-0.5 font-semibold text-orange-600">${info.ratio}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ========== 新增曲线图表渲染函数 ==========

function updateDqdvQChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dqdvQChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dqdvQ) state.charts.dqdvQ.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式
      const dd = ds.directDifferential;
      if (dd.dqdvCapacity && dd.dqdvCapacity.length > 0 && dd.dqdvQ && dd.dqdvQ.length > 0) {
        const minLen = Math.min(dd.dqdvCapacity.length, dd.dqdvQ.length);
        const data = [];
        for (let i = 0; i < minLen; i++) {
          if (isFinite(dd.dqdvCapacity[i]) && isFinite(dd.dqdvQ[i])) {
            data.push({ x: dd.dqdvCapacity[i], y: dd.dqdvQ[i] });
          }
        }
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      // 确保数据存在且长度匹配
      const capData = ds.differential.dqdvCapacity;
      const dqdvData = ds.differential.dqdvQ;
      if (!capData || !dqdvData) {
        console.log('updateDqdvQChart: capData or dqdvData is null, capData:', !!capData, 'dqdvData:', !!dqdvData);
        return;
      }
      console.log('updateDqdvQChart: capData length:', capData.length, 'dqdvData length:', dqdvData.length);
      const minLen = Math.min(capData.length, dqdvData.length);
      const data = [];
      for (let i = 0; i < minLen; i++) {
        if (isFinite(capData[i]) && isFinite(dqdvData[i])) {
          data.push({ x: capData[i], y: dqdvData[i] });
        }
      }
      if (data.length > 0) {
        chartDatasets.push({
          label: ds.name,
          data,
          borderColor: ds.color,
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        });
      }
    }
  });

  state.charts.dqdvQ = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '容量 Q (Ah)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dQ/dV (Ah/V)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDqdvSocChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dqdvSocChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dqdvSoc) state.charts.dqdvSoc.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式
      const dd = ds.directDifferential;
      if (dd.dqdvSocX && dd.dqdvSocX.length > 0 && dd.dqdvSoc && dd.dqdvSoc.length > 0) {
        const minLen = Math.min(dd.dqdvSocX.length, dd.dqdvSoc.length);
        const data = [];
        for (let i = 0; i < minLen; i++) {
          if (isFinite(dd.dqdvSocX[i]) && isFinite(dd.dqdvSoc[i])) {
            data.push({ x: dd.dqdvSocX[i], y: dd.dqdvSoc[i] });
          }
        }
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      if (!ds.differential.dqdvSocX || !ds.differential.dqdvSoc) return;
      const minLen = Math.min(ds.differential.dqdvSocX.length, ds.differential.dqdvSoc.length);
      const data = [];
      for (let i = 0; i < minLen; i++) {
        if (isFinite(ds.differential.dqdvSocX[i]) && isFinite(ds.differential.dqdvSoc[i])) {
          data.push({ x: ds.differential.dqdvSocX[i], y: ds.differential.dqdvSoc[i] });
        }
      }
      if (data.length > 0) {
        chartDatasets.push({
          label: ds.name,
          data,
          borderColor: ds.color,
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        });
      }
    }
  });

  state.charts.dqdvSoc = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: 'SOC', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dQ/dV (Ah/V)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDvdqVChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dvdqVChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dvdqV) state.charts.dvdqV.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式
      const dd = ds.directDifferential;
      if (dd.dvdqVoltage && dd.dvdqVoltage.length > 0 && dd.dvdqV && dd.dvdqV.length > 0) {
        const minLen = Math.min(dd.dvdqVoltage.length, dd.dvdqV.length);
        const data = [];
        for (let i = 0; i < minLen; i++) {
          if (isFinite(dd.dvdqVoltage[i]) && isFinite(dd.dvdqV[i])) {
            data.push({ x: dd.dvdqVoltage[i], y: dd.dvdqV[i] });
          }
        }
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      if (!ds.differential.dvdqVoltage || !ds.differential.dvdqV) {
        console.log('updateDvdqVChart: dvdqVoltage or dvdqV is null, dvdqVoltage:', !!ds.differential.dvdqVoltage, 'dvdqV:', !!ds.differential.dvdqV);
        return;
      }
      console.log('updateDvdqVChart: dvdqVoltage length:', ds.differential.dvdqVoltage.length, 'dvdqV length:', ds.differential.dvdqV.length);
      const minLen = Math.min(ds.differential.dvdqVoltage.length, ds.differential.dvdqV.length);
      const data = [];
      for (let i = 0; i < minLen; i++) {
        if (isFinite(ds.differential.dvdqVoltage[i]) && isFinite(ds.differential.dvdqV[i])) {
          data.push({ x: ds.differential.dvdqVoltage[i], y: ds.differential.dvdqV[i] });
        }
      }
      if (data.length > 0) {
        chartDatasets.push({
          label: ds.name,
          data,
          borderColor: ds.color,
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        });
      }
    }
  });

  state.charts.dvdqV = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '电压 V (V)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dV/dQ (V/Ah)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDvdqSocChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dvdqSocChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dvdqSoc) state.charts.dvdqSoc.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式
      const dd = ds.directDifferential;
      if (dd.dvdqSocX && dd.dvdqSocX.length > 0 && dd.dvdqSoc && dd.dvdqSoc.length > 0) {
        const minLen = Math.min(dd.dvdqSocX.length, dd.dvdqSoc.length);
        const data = [];
        for (let i = 0; i < minLen; i++) {
          if (isFinite(dd.dvdqSocX[i]) && isFinite(dd.dvdqSoc[i])) {
            data.push({ x: dd.dvdqSocX[i], y: dd.dvdqSoc[i] });
          }
        }
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      if (!ds.differential.dvdqSocX || !ds.differential.dvdqSoc) return;
      const minLen = Math.min(ds.differential.dvdqSocX.length, ds.differential.dvdqSoc.length);
      const data = [];
      for (let i = 0; i < minLen; i++) {
        if (isFinite(ds.differential.dvdqSocX[i]) && isFinite(ds.differential.dvdqSoc[i])) {
          data.push({ x: ds.differential.dvdqSocX[i], y: ds.differential.dvdqSoc[i] });
        }
      }
      if (data.length > 0) {
        chartDatasets.push({
          label: ds.name,
          data,
          borderColor: ds.color,
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        });
      }
    }
  });

  state.charts.dvdqSoc = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: 'SOC', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dV/dQ (V/Ah)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDsocdvQChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dsocdvQChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dsocdvQ) state.charts.dsocdvQ.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式
      const dd = ds.directDifferential;
      if (dd.dsocdvCapacity && dd.dsocdvCapacity.length > 0 && dd.dsocdvQ && dd.dsocdvQ.length > 0) {
        const minLen = Math.min(dd.dsocdvCapacity.length, dd.dsocdvQ.length);
        const data = [];
        for (let i = 0; i < minLen; i++) {
          if (isFinite(dd.dsocdvCapacity[i]) && isFinite(dd.dsocdvQ[i])) {
            data.push({ x: dd.dsocdvCapacity[i], y: dd.dsocdvQ[i] });
          }
        }
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      if (!ds.differential.dsocdvCapacity || !ds.differential.dsocdvQ) return;
      const minLen = Math.min(ds.differential.dsocdvCapacity.length, ds.differential.dsocdvQ.length);
      const data = [];
      for (let i = 0; i < minLen; i++) {
        if (isFinite(ds.differential.dsocdvCapacity[i]) && isFinite(ds.differential.dsocdvQ[i])) {
          data.push({ x: ds.differential.dsocdvCapacity[i], y: ds.differential.dsocdvQ[i] });
        }
      }
      if (data.length > 0) {
        chartDatasets.push({
          label: ds.name,
          data,
          borderColor: ds.color,
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        });
      }
    }
  });

  state.charts.dsocdvQ = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '容量 Q (Ah)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dSOC/dV (1/V)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDsocdvSocChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('dsocdvSocChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dsocdvSoc) state.charts.dsocdvSoc.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  datasets.forEach(ds => {
    // 根据 diffMode 选择数据源
    if (state.diffMode === 'direct' && ds.directDifferential) {
      // 直接差分模式
      const dd = ds.directDifferential;
      if (dd.dsocdvSocX && dd.dsocdvSocX.length > 0 && dd.dsocdvSoc && dd.dsocdvSoc.length > 0) {
        const minLen = Math.min(dd.dsocdvSocX.length, dd.dsocdvSoc.length);
        const data = [];
        for (let i = 0; i < minLen; i++) {
          if (isFinite(dd.dsocdvSocX[i]) && isFinite(dd.dsocdvSoc[i])) {
            data.push({ x: dd.dsocdvSocX[i], y: dd.dsocdvSoc[i] });
          }
        }
        if (data.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (直接差分)`,
            data,
            borderColor: ds.color,
            backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.2,
          });
        }
      }
    } else if (ds.differential) {
      // 拟合后差分模式
      if (!ds.differential.dsocdvSocX || !ds.differential.dsocdvSoc) return;
      const minLen = Math.min(ds.differential.dsocdvSocX.length, ds.differential.dsocdvSoc.length);
      const data = [];
      for (let i = 0; i < minLen; i++) {
        if (isFinite(ds.differential.dsocdvSocX[i]) && isFinite(ds.differential.dsocdvSoc[i])) {
          data.push({ x: ds.differential.dsocdvSocX[i], y: ds.differential.dsocdvSoc[i] });
        }
      }
      if (data.length > 0) {
        chartDatasets.push({
          label: ds.name,
          data,
          borderColor: ds.color,
          backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        });
      }
    }
  });

  state.charts.dsocdvSoc = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: 'SOC', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dSOC/dV (1/V)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

// ========== dQ/dI 分析图表渲染函数 ==========

function updateVSocChart(datasets: Dataset[]): void {
  const canvas = document.getElementById('vSocChart') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  datasets.forEach((ds) => {
    if (!ds.visible) return;

    let socX: number[] | undefined;
    let voltageY: number[] | undefined;

    if (state.diffMode === 'direct' && ds.directDifferential) {
      const dd = ds.directDifferential;
      if (dd.vSocX && dd.vSoc && dd.vSocX.length === dd.vSoc.length && dd.vSocX.length > 0) {
        socX = dd.vSocX;
        voltageY = dd.vSoc;
      }
    } else if (ds.differential) {
      const diff = ds.differential;
      if (diff.vSocX && diff.vSoc && diff.vSocX.length === diff.vSoc.length && diff.vSocX.length > 0) {
        socX = diff.vSocX;
        voltageY = diff.vSoc;
      }
    }

    if (socX && voltageY) {
      const data = socX.map((x, i) => ({ x, y: voltageY![i] })).filter(p => isFinite(p.x) && isFinite(p.y));
      if (data.length > 0) {
        chartDatasets.push({
          label: `${ds.name} - V vs SOC`,
          data,
          borderColor: DATASET_COLORS[state.datasets.indexOf(ds) % DATASET_COLORS.length],
          backgroundColor: DATASET_COLORS[state.datasets.indexOf(ds) % DATASET_COLORS.length] + '33',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.1,
          showLine: true
        });
      }
    }
  });

  if (state.charts.vSoc) {
    state.charts.vSoc.data.datasets = chartDatasets;
    state.charts.vSoc.update('none');
  } else {
    state.charts.vSoc = new Chart(ctx, {
      type: 'line',
      data: { datasets: chartDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
        scales: { x: { type: 'linear', title: { display: true, text: 'SOC', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: '电压 (V)', font: { size: 12 } } } },
        ...getZoomOptions(),
      }
    });
  }
}

function updateDqdiCharts(): void {
  updateCurrentCapacityChart();
  updateDqdiChart();
  updateDidqChart();
}

function updateCurrentCapacityChart(): void {
  const canvas = document.getElementById('currentCapacityChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.currentCapacity) state.charts.currentCapacity.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  const showFitted = state.dqdiParams.showFittedCurve !== false;
  
  state.datasets.filter(ds => ds.current && ds.current.length > 0).forEach(ds => {
    let currentToUse: number[];
    let capacityToUse: number[];
    
    // 优先使用CV阶段数据，如果没有CV数据则使用完整数据
    if (ds.cvData && ds.cvData.current.length > 0) {
      console.log(`使用CV段数据绘制I-Q曲线，CV段长度: ${ds.cvData.current.length}`);
      currentToUse = ds.cvData.current;
      capacityToUse = ds.cvData.capacity;
    } else if (ds.current && ds.capacity) {
      console.log(`使用完整数据绘制I-Q曲线，完整数据长度: ${ds.current.length}`);
      currentToUse = ds.current;
      capacityToUse = ds.capacity;
    } else {
      console.log(`数据集 "${ds.name}" 缺少电流或容量数据，跳过`);
      return;
    }
    
    // 使用电流和容量数据绘制I-Q曲线
    const data = capacityToUse.map((q: number, i: number) => ({ x: q, y: currentToUse[i] })).filter((p: { x: number; y: number }) => isFinite(p.x) && isFinite(p.y));
    
    console.log(`数据集 "${ds.name}" I-Q曲线有效数据点数: ${data.length}`);
    
    if (data.length > 0) {
      // 添加原始数据点
      chartDatasets.push({
        label: `${ds.name} (原始)`,
        data,
        borderColor: ds.color,
        backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.2,
      });
      
      // 如果有dqdi结果且开启了拟合曲线显示，添加拟合曲线
      if (showFitted && ds.dqdi?.fittedCurrent && ds.dqdi?.fittedCapacity) {
        const fittedData = ds.dqdi.fittedCapacity.map((q: number, i: number) => ({ x: q, y: ds.dqdi!.fittedCurrent![i] })).filter((p: { x: number; y: number }) => isFinite(p.x) && isFinite(p.y));
        
        if (fittedData.length > 0) {
          chartDatasets.push({
            label: `${ds.name} (拟合)`,
            data: fittedData,
            borderColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.7)'),
            backgroundColor: 'transparent',
            borderWidth: 2,
            borderDash: [5, 3],
            pointRadius: 0,
            fill: false,
            tension: 0.1,
          });
        }
      }
    }
  });

  state.charts.currentCapacity = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '容量 Q (Ah)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: '电流 I (A)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDqdiChart(): void {
  const canvas = document.getElementById('dqdiChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.dqdi) state.charts.dqdi.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  console.log('更新dQ/dI图表，数据集数量:', state.datasets.length);
  
  state.datasets.filter(ds => ds.dqdi).forEach(ds => {
    console.log(`处理数据集 "${ds.name}" 的dQ/dI数据:`, {
      hasDqdi: !!ds.dqdi,
      dqdiCurrentLength: ds.dqdi?.dqdiCurrent?.length,
      dqdiValueLength: ds.dqdi?.dqdiValue?.length,
      hasData: !!ds.dqdi?.dqdiCurrent && !!ds.dqdi?.dqdiValue
    });
    
    if (!ds.dqdi || !ds.dqdi.dqdiCurrent || !ds.dqdi.dqdiValue) return;
    const minLen = Math.min(ds.dqdi.dqdiCurrent.length, ds.dqdi.dqdiValue.length);
    const data = [];
    let validCount = 0;
    for (let i = 0; i < minLen; i++) {
      if (isFinite(ds.dqdi.dqdiCurrent[i]) && isFinite(ds.dqdi.dqdiValue[i])) {
        data.push({ x: ds.dqdi.dqdiCurrent[i], y: ds.dqdi.dqdiValue[i] });
        validCount++;
      }
    }
    
    // 输出数据的值范围
    if (data.length > 0) {
      const xValues = data.map(d => d.x);
      const yValues = data.map(d => d.y);
      console.log(`数据集 "${ds.name}" 有效数据点数: ${data.length}/${minLen}，值范围:`, {
        xMin: Math.min(...xValues),
        xMax: Math.max(...xValues),
        yMin: Math.min(...yValues),
        yMax: Math.max(...yValues),
        sampleY: yValues.slice(0, 5)
      });
    }
    
    if (data.length > 0) {
      chartDatasets.push({
        label: ds.name,
        data,
        borderColor: ds.color,
        backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      });
    }
  });

  console.log(`dQ/dI图表最终数据集数量: ${chartDatasets.length}`);
  
  state.charts.dqdi = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '电流 I (A)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dQ/dI (Ah/A)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function updateDidqChart(): void {
  const canvas = document.getElementById('didqChart') as HTMLCanvasElement;
  if (!canvas) return;
  if (state.charts.didq) state.charts.didq.destroy();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const chartDatasets: any[] = [];
  
  console.log('更新dI/dQ图表，数据集数量:', state.datasets.length);
  
  state.datasets.filter(ds => ds.dqdi).forEach(ds => {
    console.log(`处理数据集 "${ds.name}" 的dI/dQ数据:`, {
      hasDqdi: !!ds.dqdi,
      didqCapacityLength: ds.dqdi?.didqCapacity?.length,
      didqValueLength: ds.dqdi?.didqValue?.length,
      hasData: !!ds.dqdi?.didqCapacity && !!ds.dqdi?.didqValue
    });
    
    if (!ds.dqdi || !ds.dqdi.didqCapacity || !ds.dqdi.didqValue) return;
    const minLen = Math.min(ds.dqdi.didqCapacity.length, ds.dqdi.didqValue.length);
    const data = [];
    let validCount = 0;
    for (let i = 0; i < minLen; i++) {
      if (isFinite(ds.dqdi.didqCapacity[i]) && isFinite(ds.dqdi.didqValue[i])) {
        data.push({ x: ds.dqdi.didqCapacity[i], y: ds.dqdi.didqValue[i] });
        validCount++;
      }
    }
    
    // 输出数据的值范围
    if (data.length > 0) {
      const xValues = data.map(d => d.x);
      const yValues = data.map(d => d.y);
      console.log(`数据集 "${ds.name}" 有效数据点数: ${data.length}/${minLen}，值范围:`, {
        xMin: Math.min(...xValues),
        xMax: Math.max(...xValues),
        yMin: Math.min(...yValues),
        yMax: Math.max(...yValues),
        sampleY: yValues.slice(0, 5)
      });
    }
    
    if (data.length > 0) {
      chartDatasets.push({
        label: ds.name,
        data,
        borderColor: ds.color,
        backgroundColor: ds.color.replace('rgb', 'rgba').replace(')', ',0.1)'),
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.2,
      });
    }
  });
  
  console.log(`dI/dQ图表最终数据集数量: ${chartDatasets.length}`);

  state.charts.didq = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      devicePixelRatio: 2,
      animation: { duration: 0 },
      plugins: { legend: { display: true, position: 'top', labels: { boxWidth: 12, padding: 8, font: { size: 10 } } } },
      scales: { x: { type: 'linear', title: { display: true, text: '容量 Q (Ah)', font: { size: 12 } } }, y: { type: 'linear', title: { display: true, text: 'dI/dQ (A/Ah)', font: { size: 12 } } } },
      ...getZoomOptions(),
    },
  });
}

function detectAndShowPeaks(type: 'dqdv' | 'dvdq'): void {
  const peakParams = state.peakParams[type];
  const peaksInfo = document.getElementById(`${type}PeaksInfo`);
  const peakCount = document.getElementById(`${type}PeakCount`);
  const peaksTable = document.getElementById(`${type}PeaksTable`);
  
  // 如果未启用寻峰，隐藏峰信息并清除图表标记
  if (!peakParams.enabled) {
    state.datasets.forEach(ds => ds.peaks[type] = []);
    peaksInfo?.classList.add('hidden');
    removePeakMarkers(type);
    return;
  }

  // 对所有可见数据集进行峰检测
  const allPeaks: { dataset: Dataset; peaks: Peak[] }[] = [];
  
  state.datasets.forEach(ds => {
    if (!ds.visible || !ds.differential) {
      ds.peaks[type] = [];
      return;
    }

    const x = type === 'dqdv' ? ds.differential.fittedVoltage : ds.differential.fittedCapacity;
    const y = type === 'dqdv' ? ds.differential.dqdv : ds.differential.dvdq;

    const peakDetectionParams: PeakDetectionParams = {
      method: peakParams.method,
      minHeight: peakParams.minHeight,
      minDistance: peakParams.minDistance,
      prominence: peakParams.prominence,
      windowSize: peakParams.windowSize,
      enableNegativePeaks: peakParams.enableNegativePeaks,
    };
    
    let peaks = detectPeaks(x, y, peakDetectionParams);
    
    // 计算峰之间的距离和峰区间
    if (peaks.length > 0) {
      const xStart = Math.min(...x);
      peaks = calculatePeakDistances(peaks, xStart);
      peaks = calculatePeakIntervals(peaks, x, y);
    }
    
    ds.peaks[type] = peaks;
    if (peaks.length > 0) {
      allPeaks.push({ dataset: ds, peaks });
    }
  });

  // 更新图表，添加峰标记和区间
  updateChartWithPeaks(type, allPeaks);

  // 更新峰信息显示
  updatePeaksDisplayForType(type);
}

// 更新峰信息显示（切换数据集时调用）
function updatePeaksDisplay(): void {
  updatePeaksDisplayForType('dqdv');
  updatePeaksDisplayForType('dvdq');
}

function updatePeaksDisplayForType(type: 'dqdv' | 'dvdq'): void {
  const peaksInfo = document.getElementById(`${type}PeaksInfo`);
  const peakCount = document.getElementById(`${type}PeakCount`);
  const peaksTable = document.getElementById(`${type}PeaksTable`);
  
  const activeDataset = getActiveDataset();
  const activePeaks = activeDataset?.peaks[type] || [];

  if (activePeaks.length > 0) {
    peaksInfo?.classList.remove('hidden');
    if (peakCount) peakCount.textContent = activePeaks.length.toString();
    if (peaksTable) {
      const xLabel = type === 'dqdv' ? '电压(V)' : '容量(Ah)';
      const yLabel = type === 'dqdv' ? 'dQ/dV(Ah/V)' : 'dV/dQ(V/Ah)';
      peaksTable.textContent = formatPeaksTable(activePeaks, xLabel, yLabel);
    }
  } else {
    peaksInfo?.classList.add('hidden');
  }
}

function removePeakMarkers(type: 'dqdv' | 'dvdq'): void {
  const chart = state.charts[type];
  if (!chart) return;

  // 移除峰标记数据集
  const existingPeakIndex = chart.data.datasets.findIndex(ds => ds.label === '峰');
  if (existingPeakIndex >= 0) {
    chart.data.datasets.splice(existingPeakIndex, 1);
    chart.update('none');
  }
}

function updateChartWithPeaks(type: 'dqdv' | 'dvdq', allPeaks: { dataset: Dataset; peaks: Peak[] }[]): void {
  const chart = state.charts[type];
  if (!chart) return;

  // 移除旧的峰标记和区间数据集
  const existingPeakIndices = chart.data.datasets
    .map((ds, i) => ds.label?.includes('峰') || ds.label?.includes('区间') ? i : -1)
    .filter(i => i >= 0)
    .reverse();
  existingPeakIndices.forEach(i => chart.data.datasets.splice(i, 1));

  // 为每个数据集添加峰区间和峰标记
  allPeaks.forEach(({ dataset, peaks }) => {
    // 获取Y轴范围
    const yMin = chart.scales.y.min;
    const yMax = chart.scales.y.max;
    
    // 为每个峰添加区间框
    peaks.forEach((peak, idx) => {
      if (peak.intervalStart !== undefined && peak.intervalEnd !== undefined) {
        // 创建区间框数据（矩形）
        const boxData = [
          { x: peak.intervalStart, y: yMin },
          { x: peak.intervalStart, y: yMax },
          { x: peak.intervalEnd, y: yMax },
          { x: peak.intervalEnd, y: yMin },
        ];
        
        chart.data.datasets.push({
          label: `P${idx + 1}区间`,
          data: boxData,
          type: 'line',
          borderColor: dataset.color.replace('rgb', 'rgba').replace(')', ',0.3)'),
          backgroundColor: dataset.color.replace('rgb', 'rgba').replace(')', ',0.08)'),
          borderWidth: 1,
          fill: true,
          pointRadius: 0,
          tension: 0,
        } as any);
      }
    });
    
    // 添加峰标记点
    const peakData = peaks.map(p => ({ x: p.position, y: p.height }));
    chart.data.datasets.push({
      label: `${dataset.name} 峰`,
      data: peakData,
      type: 'scatter',
      backgroundColor: dataset.color.replace('rgb', 'rgba').replace(')', ',0.9)'),
      borderColor: dataset.color,
      pointRadius: 6,
      pointStyle: 'triangle',
    } as any);
    
    // 添加峰编号标注
    peaks.forEach((peak, idx) => {
      chart.data.datasets.push({
        label: `P${idx + 1}`,
        data: [{ x: peak.position, y: peak.height * 1.05 }],
        type: 'scatter',
        pointRadius: 0,
        datalabels: {
          display: true,
          align: 'top',
          formatter: () => `P${idx + 1}`,
          color: dataset.color,
          font: { size: 10, weight: 'bold' }
        }
      } as any);
    });
  });

  chart.update('none');
}

function showDqdvExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { fittedVoltage, dqdv } = activeDataset.differential;
  const lines = ['电压(V)\tdQ/dV(Ah/V)'];
  for (let i = 0; i < fittedVoltage.length; i++) lines.push(`${fittedVoltage[i].toFixed(6)}\t${dqdv[i].toFixed(8)}`);
  const area = document.getElementById('dqdvDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dqdvExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function showDvdqExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { fittedCapacity, dvdq } = activeDataset.differential;
  const lines = ['容量(Ah)\tdV/dQ(V/Ah)'];
  for (let i = 0; i < fittedCapacity.length; i++) lines.push(`${fittedCapacity[i].toFixed(6)}\t${dvdq[i].toFixed(8)}`);
  const area = document.getElementById('dvdqDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dvdqExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function showDsocdvExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { fittedVoltage, dsocdv } = activeDataset.differential;
  const lines = ['电压(V)\tdSOC/dV(1/V)'];
  for (let i = 0; i < fittedVoltage.length; i++) lines.push(`${fittedVoltage[i].toFixed(6)}\t${dsocdv[i].toFixed(8)}`);
  const area = document.getElementById('dsocdvDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dsocdvExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

// ========== 新增曲线导出函数 ==========
function showDqdvQExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { dqdvCapacity, dqdvQ } = activeDataset.differential;
  const lines = ['容量(Ah)\tdQ/dV(Ah/V)'];
  for (let i = 0; i < dqdvCapacity.length; i++) lines.push(`${dqdvCapacity[i].toFixed(6)}\t${dqdvQ[i].toFixed(8)}`);
  const area = document.getElementById('dqdvQDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dqdvQExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function showDqdvSocExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { dqdvSocX, dqdvSoc } = activeDataset.differential;
  const lines = ['SOC\tdQ/dV(Ah/V)'];
  for (let i = 0; i < dqdvSocX.length; i++) lines.push(`${dqdvSocX[i].toFixed(6)}\t${dqdvSoc[i].toFixed(8)}`);
  const area = document.getElementById('dqdvSocDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dqdvSocExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function showDvdqVExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { dvdqVoltage, dvdqV } = activeDataset.differential;
  const lines = ['电压(V)\tdV/dQ(V/Ah)'];
  for (let i = 0; i < dvdqVoltage.length; i++) lines.push(`${dvdqVoltage[i].toFixed(6)}\t${dvdqV[i].toFixed(8)}`);
  const area = document.getElementById('dvdqVDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dvdqVExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function showDvdqSocExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { dvdqSocX, dvdqSoc } = activeDataset.differential;
  const lines = ['SOC\tdV/dQ(V/Ah)'];
  for (let i = 0; i < dvdqSocX.length; i++) lines.push(`${dvdqSocX[i].toFixed(6)}\t${dvdqSoc[i].toFixed(8)}`);
  const area = document.getElementById('dvdqSocDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dvdqSocExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function showDsocdvQExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { dsocdvCapacity, dsocdvQ } = activeDataset.differential;
  const lines = ['容量(Ah)\tdSOC/dV(1/V)'];
  for (let i = 0; i < dsocdvCapacity.length; i++) lines.push(`${dsocdvCapacity[i].toFixed(6)}\t${dsocdvQ[i].toFixed(8)}`);
  const area = document.getElementById('dsocdvQDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dsocdvQExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function showDsocdvSocExport(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset?.differential) return;
  const { dsocdvSocX, dsocdvSoc } = activeDataset.differential;
  const lines = ['SOC\tdSOC/dV(1/V)'];
  for (let i = 0; i < dsocdvSocX.length; i++) lines.push(`${dsocdvSocX[i].toFixed(6)}\t${dsocdvSoc[i].toFixed(8)}`);
  const area = document.getElementById('dsocdvSocDataArea') as HTMLTextAreaElement;
  const exp = document.getElementById('dsocdvSocExport');
  if (area) area.value = lines.join('\n');
  exp?.classList.remove('hidden');
}

function copyToClipboard(areaId: string): void {
  const area = document.getElementById(areaId) as HTMLTextAreaElement;
  if (!area) return;
  copyTextToClipboard(area.value);
}

function copyTextToClipboard(text: string): void {
  navigator.clipboard.writeText(text).then(() => {
    console.log('已复制到剪贴板');
  }).catch(() => {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  });
}

async function exportChartImage(containerId: string, filename: string): Promise<void> {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  try {
    const canvas = await html2canvas(container, {
      backgroundColor: '#ffffff',
      scale: 2,
    });
    
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (error) {
    console.error('导出图片失败:', error);
  }
}

/**
 * 获取数据集对应的差分数据（根据diffMode选择differential或directDifferential）
 */
function getDiffData(ds: Dataset) {
  if (state.diffMode === 'direct' && ds.directDifferential) {
    return {
      // dQ/dV vs V
      dqdvVoltage: ds.directDifferential.fittedDqdv?.voltage || [],
      dqdv: ds.directDifferential.fittedDqdv?.dqdv || [],
      // dV/dQ vs V
      dvdqVoltage: ds.directDifferential.dvdqVoltage || [],
      dvdqV: ds.directDifferential.dvdqV || [],
      // dV/dQ vs Q
      dvdqCapacity: ds.directDifferential.fittedDvdq?.capacity || [],
      // dQ/dV vs Q
      dqdvCapacity: ds.directDifferential.dqdvCapacity || [],
      dqdvQ: ds.directDifferential.dqdvQ || [],
      // dQ/dV vs SOC
      dqdvSocX: ds.directDifferential.dqdvSocX || [],
      dqdvSoc: ds.directDifferential.dqdvSoc || [],
      // dV/dQ vs SOC
      dvdqSocX: ds.directDifferential.dvdqSocX || [],
      dvdqSoc: ds.directDifferential.dvdqSoc || [],
      // dSOC/dV
      dsocdv: ds.directDifferential.dsocdv || [],
      // dSOC/dV vs Q
      dsocdvCapacity: ds.directDifferential.dsocdvCapacity || [],
      dsocdvQ: ds.directDifferential.dsocdvQ || [],
      // dSOC/dV vs SOC
      dsocdvSocX: ds.directDifferential.dsocdvSocX || [],
      dsocdvSoc: ds.directDifferential.dsocdvSoc || [],
      // V vs SOC
      vSoc: ds.directDifferential.vSoc || [],
      vSocX: ds.directDifferential.vSocX || [],
    };
  }
  return ds.differential || null;
}

/**
 * 汇总导出所有数据集到Excel
 * 包含4个sheet：原始数据、拟合曲线、dQ/dV、dV/dQ
 * 每个sheet包含所有数据集的数据，按列排列
 */
async function exportAllDatasetsToExcel(): Promise<void> {
  try {
    // 导出所有数据集，包括空数据集
    if (state.datasets.length === 0) {
      alert('没有可导出的数据');
      return;
    }

    // 让用户输入文件名
    const defaultFileName = `电化学差分分析_${new Date().toISOString().slice(0, 10)}`;
    const fileName = prompt('请输入导出文件名：', defaultFileName);
    if (!fileName) return; // 用户取消

    const workbook = new ExcelJS.Workbook();
    workbook.creator = '电化学差分分析工具';

    // 导出所有数据集（包括空数据集），但只显示可见的
    const visibleDatasets = state.datasets.filter(ds => ds.visible);
    if (visibleDatasets.length === 0) {
      alert('没有可见的数据集可导出');
      return;
    }

    // 颜色配置
    const headerFill = {
      type: 'pattern' as const,
      pattern: 'solid' as const,
      fgColor: { argb: 'FF4472C4' }
    };
    const headerFont = { bold: true, color: { argb: 'FFFFFFFF' } };

    // ==================== Sheet 1: 原始数据 ====================
    const rawSheet = workbook.addWorksheet('原始数据');
    
    // 计算最大数据点数（空数据集为0）
    const maxRawPoints = Math.max(...visibleDatasets.map(ds => ds.voltage.length), 1);
    
    // 检查是否有任何数据集包含电流数据（CC-CV模式）
    const hasCurrentData = visibleDatasets.some(ds => 
      (ds.current && ds.current.length > 0)
    );
    
    // 构建表头 - 保持原始列顺序，只调换电压和容量位置
    const rawHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      if (hasCurrentData) {
        // 三列：电流-容量-电压（保持电流在前，只调换电压和容量）
        rawHeaders.push(`${ds.name}-电流(A)`, `${ds.name}-容量(Ah)`, `${ds.name}-电压(V)`);
      } else {
        // 两列：容量-电压
        rawHeaders.push(`${ds.name}-容量(Ah)`, `${ds.name}-电压(V)`);
      }
    });
    rawSheet.columns = rawHeaders.map(h => ({ header: h, key: h, width: 15 }));
    
    // 填充数据 - 保持原始列顺序，只调换电压和容量位置
    for (let i = 0; i < maxRawPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        if (hasCurrentData) {
          // 三列：电流-容量-电压
          const currentValue = ds.current?.[i];
          row[`${ds.name}-电流(A)`] = currentValue !== undefined ? currentValue : '';
          row[`${ds.name}-容量(Ah)`] = ds.capacity[i] !== undefined ? ds.capacity[i] : '';
          row[`${ds.name}-电压(V)`] = ds.voltage[i] !== undefined ? ds.voltage[i] : '';
        } else {
          // 两列：容量-电压
          row[`${ds.name}-容量(Ah)`] = ds.capacity[i] !== undefined ? ds.capacity[i] : '';
          row[`${ds.name}-电压(V)`] = ds.voltage[i] !== undefined ? ds.voltage[i] : '';
        }
      });
      rawSheet.addRow(row);
    }
    
    // 设置表头样式
    rawSheet.getRow(1).fill = headerFill;
    rawSheet.getRow(1).font = headerFont;

    // ==================== Sheet 2: 拟合曲线 ====================
    const fittingSheet = workbook.addWorksheet('拟合曲线');
    
    // 计算最大拟合点数
    const maxFitPoints = Math.max(...visibleDatasets.map(ds => 
      ds.fitting?.uniformCapacity.length || ds.differential?.uniformCapacity.length || 0
    ), 1);
    
    // 构建表头
    const fitHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      fitHeaders.push(`${ds.name}-容量(Ah)`, `${ds.name}-拟合电压(V)`);
    });
    fittingSheet.columns = fitHeaders.map(h => ({ header: h, key: h, width: 15 }));
    
    // 填充数据
    for (let i = 0; i < maxFitPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const fitData = ds.fitting || ds.differential;
        if (fitData) {
          row[`${ds.name}-容量(Ah)`] = fitData.uniformCapacity[i] !== undefined ? fitData.uniformCapacity[i] : '';
          row[`${ds.name}-拟合电压(V)`] = fitData.fittedVoltage[i] !== undefined ? fitData.fittedVoltage[i] : '';
        } else {
          row[`${ds.name}-容量(Ah)`] = '';
          row[`${ds.name}-拟合电压(V)`] = '';
        }
      });
      fittingSheet.addRow(row);
    }
    
    fittingSheet.getRow(1).fill = headerFill;
    fittingSheet.getRow(1).font = headerFont;

    // ==================== Sheet 3: dQ/dV 数据 ====================
    const dqdvSheet = workbook.addWorksheet('dQ-dV');
    
    // 计算最大dQ/dV点数
    const maxDqdvPoints = Math.max(...visibleDatasets.map(ds => {
      if (ds.differential?.dqdvVoltage) {
        return ds.differential.dqdvVoltage.length;
      }
      return ds.differential?.voltage.length || 0;
    }));
    
    // 构建表头
    const dqdvHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dqdvHeaders.push(`${ds.name}-电压(V)`, `${ds.name}-dQ/dV(Ah/V)`);
    });
    dqdvSheet.columns = dqdvHeaders.map(h => ({ header: h, key: h, width: 18 }));
    
    // 填充数据
    for (let i = 0; i < maxDqdvPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        if (ds.differential) {
          // 优先使用独立的电压数组（改进方法）
          const voltageData = ds.differential.dqdvVoltage || ds.differential.uniformVoltage;
          row[`${ds.name}-电压(V)`] = voltageData[i] !== undefined ? voltageData[i] : '';
          row[`${ds.name}-dQ/dV(Ah/V)`] = ds.differential.dqdv[i] !== undefined ? ds.differential.dqdv[i] : '';
        } else {
          row[`${ds.name}-电压(V)`] = '';
          row[`${ds.name}-dQ/dV(Ah/V)`] = '';
        }
      });
      dqdvSheet.addRow(row);
    }
    
    dqdvSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF22C55E' }  // 绿色
    };
    dqdvSheet.getRow(1).font = headerFont;

    // ==================== Sheet 4: dV/dQ 数据 ====================
    const dvdqSheet = workbook.addWorksheet('dV-dQ');
    
    // 计算最大dV/dQ点数
    const maxDvdqPoints = Math.max(...visibleDatasets.map(ds => {
      if (ds.differential?.dvdqCapacity) {
        return ds.differential.dvdqCapacity.length;
      }
      return ds.differential?.uniformCapacity.length || 0;
    }));
    
    // 构建表头
    const dvdqHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dvdqHeaders.push(`${ds.name}-容量(Ah)`, `${ds.name}-dV/dQ(V/Ah)`);
    });
    dvdqSheet.columns = dvdqHeaders.map(h => ({ header: h, key: h, width: 18 }));
    
    // 填充数据
    for (let i = 0; i < maxDvdqPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        if (ds.differential) {
          // 优先使用独立的容量数组（改进方法）
          const capacityData = ds.differential.dvdqCapacity || ds.differential.uniformCapacity;
          row[`${ds.name}-容量(Ah)`] = capacityData[i] !== undefined ? capacityData[i] : '';
          row[`${ds.name}-dV/dQ(V/Ah)`] = ds.differential.dvdq[i] !== undefined ? ds.differential.dvdq[i] : '';
        } else {
          row[`${ds.name}-容量(Ah)`] = '';
          row[`${ds.name}-dV/dQ(V/Ah)`] = '';
        }
      });
      dvdqSheet.addRow(row);
    }
    
    dvdqSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFA855F7' }  // 紫色
    };
    dvdqSheet.getRow(1).font = headerFont;

    // ==================== Sheet 5: dSOC/dV 数据 ====================
    const dsocdvSheet = workbook.addWorksheet('dSOC-dV');
    
    // 计算最大dSOC/dV点数（支持两种差分模式）
    const maxDsocdvPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return (diff?.dqdvVoltage?.length || diff?.dqdv?.length || 0);
    }), 0);
    
    // 构建表头
    const dsocdvHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dsocdvHeaders.push(`${ds.name}-电压(V)`, `${ds.name}-dSOC/dV(1/V)`);
    });
    dsocdvSheet.columns = dsocdvHeaders.map(h => ({ header: h, key: h, width: 18 }));
    
    // 填充数据
    for (let i = 0; i < maxDsocdvPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-电压(V)`] = diff.dqdvVoltage?.[i] ?? '';
          row[`${ds.name}-dSOC/dV(1/V)`] = diff.dsocdv?.[i] ?? '';
        } else {
          row[`${ds.name}-电压(V)`] = '';
          row[`${ds.name}-dSOC/dV(1/V)`] = '';
        }
      });
      dsocdvSheet.addRow(row);
    }
    
    dsocdvSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF97316' }  // 橙色
    };
    dsocdvSheet.getRow(1).font = headerFont;

    // ==================== Sheet 6: dQ/dV vs Q 数据 ====================
    const dqdvQSheet = workbook.addWorksheet('dQ-dV-Q');
    const maxDqdvQPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return diff?.dqdvCapacity.length || 0;
    }), 0);
    const dqdvQHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dqdvQHeaders.push(`${ds.name}-容量(Ah)`, `${ds.name}-dQ/dV(Ah/V)`);
    });
    dqdvQSheet.columns = dqdvQHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDqdvQPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-容量(Ah)`] = diff.dqdvCapacity[i] !== undefined ? diff.dqdvCapacity[i] : '';
          row[`${ds.name}-dQ/dV(Ah/V)`] = diff.dqdvQ[i] !== undefined ? diff.dqdvQ[i] : '';
        } else {
          row[`${ds.name}-容量(Ah)`] = '';
          row[`${ds.name}-dQ/dV(Ah/V)`] = '';
        }
      });
      dqdvQSheet.addRow(row);
    }
    dqdvQSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14B8A6' } };
    dqdvQSheet.getRow(1).font = headerFont;

    // ==================== Sheet 7: dQ/dV vs SOC 数据 ====================
    const dqdvSocSheet = workbook.addWorksheet('dQ-dV-SOC');
    const maxDqdvSocPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return diff?.dqdvSocX.length || 0;
    }), 0);
    const dqdvSocHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dqdvSocHeaders.push(`${ds.name}-SOC`, `${ds.name}-dQ/dV(Ah/V)`);
    });
    dqdvSocSheet.columns = dqdvSocHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDqdvSocPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-SOC`] = diff.dqdvSocX[i] !== undefined ? diff.dqdvSocX[i] : '';
          row[`${ds.name}-dQ/dV(Ah/V)`] = diff.dqdvSoc[i] !== undefined ? diff.dqdvSoc[i] : '';
        } else {
          row[`${ds.name}-SOC`] = '';
          row[`${ds.name}-dQ/dV(Ah/V)`] = '';
        }
      });
      dqdvSocSheet.addRow(row);
    }
    dqdvSocSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF06B6D4' } };
    dqdvSocSheet.getRow(1).font = headerFont;

    // ==================== Sheet 8: dV/dQ vs V 数据 ====================
    const dvdqVSheet = workbook.addWorksheet('dV-dQ-V');
    const maxDvdqVPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return diff?.dvdqVoltage.length || 0;
    }), 0);
    const dvdqVHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dvdqVHeaders.push(`${ds.name}-电压(V)`, `${ds.name}-dV/dQ(V/Ah)`);
    });
    dvdqVSheet.columns = dvdqVHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDvdqVPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-电压(V)`] = diff.dvdqVoltage[i] !== undefined ? diff.dvdqVoltage[i] : '';
          row[`${ds.name}-dV/dQ(V/Ah)`] = diff.dvdqV[i] !== undefined ? diff.dvdqV[i] : '';
        } else {
          row[`${ds.name}-电压(V)`] = '';
          row[`${ds.name}-dV/dQ(V/Ah)`] = '';
        }
      });
      dvdqVSheet.addRow(row);
    }
    dvdqVSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF43F5E' } };
    dvdqVSheet.getRow(1).font = headerFont;

    // ==================== Sheet 9: dV/dQ vs SOC 数据 ====================
    const dvdqSocSheet = workbook.addWorksheet('dV-dQ-SOC');
    const maxDvdqSocPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return diff?.dvdqSocX.length || 0;
    }), 0);
    const dvdqSocHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dvdqSocHeaders.push(`${ds.name}-SOC`, `${ds.name}-dV/dQ(V/Ah)`);
    });
    dvdqSocSheet.columns = dvdqSocHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDvdqSocPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-SOC`] = diff.dvdqSocX[i] !== undefined ? diff.dvdqSocX[i] : '';
          row[`${ds.name}-dV/dQ(V/Ah)`] = diff.dvdqSoc[i] !== undefined ? diff.dvdqSoc[i] : '';
        } else {
          row[`${ds.name}-SOC`] = '';
          row[`${ds.name}-dV/dQ(V/Ah)`] = '';
        }
      });
      dvdqSocSheet.addRow(row);
    }
    dvdqSocSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEC4899' } };
    dvdqSocSheet.getRow(1).font = headerFont;

    // ==================== Sheet 10: dSOC/dV vs Q 数据 ====================
    const dsocdvQSheet = workbook.addWorksheet('dSOC-dV-Q');
    const maxDsocdvQPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return diff?.dsocdvCapacity.length || 0;
    }), 0);
    const dsocdvQHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dsocdvQHeaders.push(`${ds.name}-容量(Ah)`, `${ds.name}-dSOC/dV(1/V)`);
    });
    dsocdvQSheet.columns = dsocdvQHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDsocdvQPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-容量(Ah)`] = diff.dsocdvCapacity[i] !== undefined ? diff.dsocdvCapacity[i] : '';
          row[`${ds.name}-dSOC/dV(1/V)`] = diff.dsocdvQ[i] !== undefined ? diff.dsocdvQ[i] : '';
        } else {
          row[`${ds.name}-容量(Ah)`] = '';
          row[`${ds.name}-dSOC/dV(1/V)`] = '';
        }
      });
      dsocdvQSheet.addRow(row);
    }
    dsocdvQSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF59E0B' } };
    dsocdvQSheet.getRow(1).font = headerFont;

    // ==================== Sheet 11: dSOC/dV vs SOC 数据 ====================
    const dsocdvSocSheet = workbook.addWorksheet('dSOC-dV-SOC');
    const maxDsocdvSocPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return diff?.dsocdvSocX.length || 0;
    }), 0);
    const dsocdvSocHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dsocdvSocHeaders.push(`${ds.name}-SOC`, `${ds.name}-dSOC/dV(1/V)`);
    });
    dsocdvSocSheet.columns = dsocdvSocHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDsocdvSocPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-SOC`] = diff.dsocdvSocX[i] !== undefined ? diff.dsocdvSocX[i] : '';
          row[`${ds.name}-dSOC/dV(1/V)`] = diff.dsocdvSoc[i] !== undefined ? diff.dsocdvSoc[i] : '';
        } else {
          row[`${ds.name}-SOC`] = '';
          row[`${ds.name}-dSOC/dV(1/V)`] = '';
        }
      });
      dsocdvSocSheet.addRow(row);
    }
    dsocdvSocSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF84CC16' } };
    dsocdvSocSheet.getRow(1).font = headerFont;

    // ==================== Sheet 12: V vs SOC 数据 ====================
    const vSocSheet = workbook.addWorksheet('V-SOC');
    const maxVSocPoints = Math.max(...visibleDatasets.map(ds => {
      const diff = getDiffData(ds);
      return diff?.vSocX?.length || diff?.vSoc?.length || 0;
    }), 0);
    const vSocHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      vSocHeaders.push(`${ds.name}-SOC`, `${ds.name}-电压(V)`);
    });
    vSocSheet.columns = vSocHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxVSocPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        const diff = getDiffData(ds);
        if (diff) {
          row[`${ds.name}-SOC`] = diff.vSocX?.[i] !== undefined ? diff.vSocX[i] : '';
          row[`${ds.name}-电压(V)`] = diff.vSoc?.[i] !== undefined ? diff.vSoc[i] : '';
        } else {
          row[`${ds.name}-SOC`] = '';
          row[`${ds.name}-电压(V)`] = '';
        }
      });
      vSocSheet.addRow(row);
    }
    vSocSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B5CF6' } };
    vSocSheet.getRow(1).font = headerFont;

    // ==================== Sheet 13: I-Q 数据（恒压模式） ====================
    const iqSheet = workbook.addWorksheet('I-Q');
    const maxIQPoints = Math.max(...visibleDatasets.map(ds => ds.dqdi?.current.length || 0));
    const iqHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      iqHeaders.push(`${ds.name}-容量(Ah)`, `${ds.name}-电流(A)`);
    });
    iqSheet.columns = iqHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxIQPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        if (ds.dqdi) {
          row[`${ds.name}-容量(Ah)`] = ds.dqdi.capacity[i] !== undefined ? ds.dqdi.capacity[i] : '';
          row[`${ds.name}-电流(A)`] = ds.dqdi.current[i] !== undefined ? ds.dqdi.current[i] : '';
        } else {
          row[`${ds.name}-容量(Ah)`] = '';
          row[`${ds.name}-电流(A)`] = '';
        }
      });
      iqSheet.addRow(row);
    }
    iqSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } };
    iqSheet.getRow(1).font = headerFont;

    // ==================== Sheet 13: dQ/dI vs I 数据（恒压模式） ====================
    const dqdiSheet = workbook.addWorksheet('dQ-dI');
    const maxDqdiPoints = Math.max(...visibleDatasets.map(ds => ds.dqdi?.dqdiCurrent.length || 0));
    const dqdiHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      dqdiHeaders.push(`${ds.name}-电流(A)`, `${ds.name}-dQ/dI(Ah/A)`);
    });
    dqdiSheet.columns = dqdiHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDqdiPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        if (ds.dqdi) {
          row[`${ds.name}-电流(A)`] = ds.dqdi.dqdiCurrent[i] !== undefined ? ds.dqdi.dqdiCurrent[i] : '';
          row[`${ds.name}-dQ/dI(Ah/A)`] = ds.dqdi.dqdiValue[i] !== undefined ? ds.dqdi.dqdiValue[i] : '';
        } else {
          row[`${ds.name}-电流(A)`] = '';
          row[`${ds.name}-dQ/dI(Ah/A)`] = '';
        }
      });
      dqdiSheet.addRow(row);
    }
    dqdiSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEA580C' } };
    dqdiSheet.getRow(1).font = headerFont;

    // ==================== Sheet 14: dI/dQ vs Q 数据（恒压模式） ====================
    const didqSheet = workbook.addWorksheet('dI-dQ');
    const maxDidqPoints = Math.max(...visibleDatasets.map(ds => ds.dqdi?.didqCapacity.length || 0));
    const didqHeaders: string[] = ['序号'];
    visibleDatasets.forEach(ds => {
      didqHeaders.push(`${ds.name}-容量(Ah)`, `${ds.name}-dI/dQ(A/Ah)`);
    });
    didqSheet.columns = didqHeaders.map(h => ({ header: h, key: h, width: 18 }));
    for (let i = 0; i < maxDidqPoints; i++) {
      const row: Record<string, number | string> = { '序号': i + 1 };
      visibleDatasets.forEach(ds => {
        if (ds.dqdi) {
          row[`${ds.name}-容量(Ah)`] = ds.dqdi.didqCapacity[i] !== undefined ? ds.dqdi.didqCapacity[i] : '';
          row[`${ds.name}-dI/dQ(A/Ah)`] = ds.dqdi.didqValue[i] !== undefined ? ds.dqdi.didqValue[i] : '';
        } else {
          row[`${ds.name}-容量(Ah)`] = '';
          row[`${ds.name}-dI/dQ(A/Ah)`] = '';
        }
      });
      didqSheet.addRow(row);
    }
    didqSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
    didqSheet.getRow(1).font = headerFont;

    // ==================== 生成文件并下载 ====================
    const finalFileName = `${fileName}.xlsx`;
    
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = finalFileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);

    const datasetNames = visibleDatasets.map(ds => ds.name).join('、');
    alert(`Excel汇总导出成功！\n\n文件名: ${finalFileName}\n\n包含数据集: ${datasetNames}\n\n工作表:\n• 原始数据 - 所有数据集的原始数据（容量-电压）\n• 拟合曲线 - 所有数据集的拟合结果\n• dQ-dV - 所有数据集的dQ/dV vs V数据\n• dV-dQ - 所有数据集的dV/dQ vs Q数据\n• dSOC-dV - 所有数据集的dSOC/dV vs V数据\n• dQ-dV-Q - 所有数据集的dQ/dV vs Q数据\n• dQ-dV-SOC - 所有数据集的dQ/dV vs SOC数据\n• dV-dQ-V - 所有数据集的dV/dQ vs V数据\n• dV-dQ-SOC - 所有数据集的dV/dQ vs SOC数据\n• dSOC-dV-Q - 所有数据集的dSOC/dV vs Q数据\n• dSOC-dV-SOC - 所有数据集的dSOC/dV vs SOC数据\n• V-SOC - 所有数据集的电压 vs SOC数据\n• I-Q - 恒压模式电流-容量数据\n• dQ-dI - 恒压模式dQ/dI vs I数据\n• dI-dQ - 恒压模式dI/dQ vs Q数据`);

    console.log('Excel汇总导出成功:', finalFileName);
  } catch (error) {
    console.error('Excel汇总导出失败:', error);
    alert('Excel汇总导出失败: ' + (error as Error).message);
  }
}

// Excel导出功能（纯前端，导出数据汇总）
async function exportToExcel(type: 'dqdv' | 'dvdq' | 'dsocdv'): Promise<void> {
  try {
    const activeDataset = getActiveDataset();
    if (!activeDataset) {
      alert('没有可导出的数据');
      return;
    }
    
    // 让用户输入文件名
    const typeLabels: Record<string, string> = {
      'dqdv': 'dQ-dV',
      'dvdq': 'dV-dQ',
      'dsocdv': 'dSOC-dV'
    };
    const defaultFileName = `${activeDataset.name}_${typeLabels[type]}`;
    const fileName = prompt('请输入导出文件名：', defaultFileName);
    if (!fileName) return; // 用户取消
    
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '电化学差分分析工具';
    
    const datasetName = activeDataset.name || '数据集';
  
    // ==================== 工作表1: 源数据 ====================
    const sourceSheet = workbook.addWorksheet('源数据');
    sourceSheet.columns = [
      { header: '序号', key: 'index', width: 8 },
      { header: '电压(V)', key: 'voltage', width: 15 },
      { header: '容量(Ah)', key: 'capacity', width: 15 },
    ];
    activeDataset.voltage.forEach((v, i) => {
      sourceSheet.addRow({ index: i + 1, voltage: v, capacity: activeDataset.capacity[i] });
    });
    
    // 设置表头样式
    sourceSheet.getRow(1).font = { bold: true };
    sourceSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    sourceSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    
    // ==================== 工作表2: 差分数据 ====================
    if (type === 'dqdv' && activeDataset.differential) {
      const dqdvSheet = workbook.addWorksheet('dQ-dV数据');
      dqdvSheet.columns = [
        { header: '序号', key: 'index', width: 8 },
        { header: '电压(V)', key: 'voltage', width: 15 },
        { header: 'dQ/dV(Ah/V)', key: 'dqdv', width: 18 },
      ];
      activeDataset.differential.voltage.forEach((v, i) => {
        dqdvSheet.addRow({ 
          index: i + 1, 
          voltage: v, 
          dqdv: activeDataset.differential!.dqdv[i] 
        });
      });
      
      dqdvSheet.getRow(1).font = { bold: true };
      dqdvSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      };
      dqdvSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      
      // ==================== 工作表3: 峰信息 ====================
      if (activeDataset.peaks.dqdv.length > 0) {
        const peaksSheet = workbook.addWorksheet('峰信息');
        peaksSheet.columns = [
          { header: '峰编号', key: 'peakNum', width: 10 },
          { header: '电压(V)', key: 'position', width: 12 },
          { header: '峰高(Ah/V)', key: 'height', width: 15 },
          { header: '峰强', key: 'intensity', width: 15 },
          { header: '区间起点(V)', key: 'intervalStart', width: 14 },
          { header: '区间终点(V)', key: 'intervalEnd', width: 14 },
          { header: '峰宽(V)', key: 'width', width: 12 },
          { header: '距起点(V)', key: 'distFromStart', width: 12 },
          { header: '距下峰(V)', key: 'distToNext', width: 12 },
        ];
        activeDataset.peaks.dqdv.forEach((p, i) => {
          peaksSheet.addRow({
            peakNum: `P${i + 1}`,
            position: p.position,
            height: p.height,
            intensity: p.intensity,
            intervalStart: p.intervalStart,
            intervalEnd: p.intervalEnd,
            width: p.width,
            distFromStart: p.distanceFromStart,
            distToNext: p.distanceToNext,
          });
        });
        
        peaksSheet.getRow(1).font = { bold: true };
        peaksSheet.getRow(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF4472C4' }
        };
        peaksSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      }
      
    } else if (type === 'dvdq' && activeDataset.differential) {
      const dvdqSheet = workbook.addWorksheet('dV-dQ数据');
      dvdqSheet.columns = [
        { header: '序号', key: 'index', width: 8 },
        { header: '容量(Ah)', key: 'capacity', width: 15 },
        { header: 'dV/dQ(V/Ah)', key: 'dvdq', width: 18 },
      ];
      activeDataset.differential.capacity.forEach((c, i) => {
        dvdqSheet.addRow({ 
          index: i + 1, 
          capacity: c, 
          dvdq: activeDataset.differential!.dvdq[i] 
        });
      });
      
      dvdqSheet.getRow(1).font = { bold: true };
      dvdqSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      };
      dvdqSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      
      // ==================== 工作表3: 峰信息 ====================
      if (activeDataset.peaks.dvdq.length > 0) {
        const peaksSheet = workbook.addWorksheet('峰信息');
        peaksSheet.columns = [
          { header: '峰编号', key: 'peakNum', width: 10 },
          { header: '容量(Ah)', key: 'position', width: 12 },
          { header: '峰高(V/Ah)', key: 'height', width: 15 },
          { header: '峰强', key: 'intensity', width: 15 },
          { header: '区间起点(Ah)', key: 'intervalStart', width: 14 },
          { header: '区间终点(Ah)', key: 'intervalEnd', width: 14 },
          { header: '峰宽(Ah)', key: 'width', width: 12 },
          { header: '距起点(Ah)', key: 'distFromStart', width: 12 },
          { header: '距下峰(Ah)', key: 'distToNext', width: 12 },
        ];
        activeDataset.peaks.dvdq.forEach((p, i) => {
          peaksSheet.addRow({
            peakNum: `P${i + 1}`,
            position: p.position,
            height: p.height,
            intensity: p.intensity,
            intervalStart: p.intervalStart,
            intervalEnd: p.intervalEnd,
            width: p.width,
            distFromStart: p.distanceFromStart,
            distToNext: p.distanceToNext,
          });
        });
        
        peaksSheet.getRow(1).font = { bold: true };
        peaksSheet.getRow(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF4472C4' }
        };
        peaksSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      }
    } else if (type === 'dsocdv' && activeDataset.differential) {
      const dsocdvSheet = workbook.addWorksheet('dSOC-dV数据');
      dsocdvSheet.columns = [
        { header: '序号', key: 'index', width: 8 },
        { header: '电压(V)', key: 'voltage', width: 15 },
        { header: 'dSOC/dV(1/V)', key: 'dsocdv', width: 18 },
      ];
      activeDataset.differential.voltage.forEach((v, i) => {
        dsocdvSheet.addRow({ 
          index: i + 1, 
          voltage: v, 
          dsocdv: activeDataset.differential!.dsocdv[i] 
        });
      });
      
      dsocdvSheet.getRow(1).font = { bold: true };
      dsocdvSheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF97306' }
      };
      dsocdvSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      
      // ==================== 工作表3: 峰信息 ====================
      if (activeDataset.peaks.dsocdv.length > 0) {
        const peaksSheet = workbook.addWorksheet('峰信息');
        peaksSheet.columns = [
          { header: '峰编号', key: 'peakNum', width: 10 },
          { header: '电压(V)', key: 'position', width: 12 },
          { header: '峰高(1/V)', key: 'height', width: 15 },
          { header: '峰强', key: 'intensity', width: 15 },
          { header: '区间起点(V)', key: 'intervalStart', width: 14 },
          { header: '区间终点(V)', key: 'intervalEnd', width: 14 },
          { header: '峰宽(V)', key: 'width', width: 12 },
          { header: '距起点(V)', key: 'distFromStart', width: 12 },
          { header: '距下峰(V)', key: 'distToNext', width: 12 },
        ];
        activeDataset.peaks.dsocdv.forEach((p, i) => {
          peaksSheet.addRow({
            peakNum: `P${i + 1}`,
            position: p.position,
            height: p.height,
            intensity: p.intensity,
            intervalStart: p.intervalStart,
            intervalEnd: p.intervalEnd,
            width: p.width,
            distFromStart: p.distanceFromStart,
            distToNext: p.distanceToNext,
          });
        });
        
        peaksSheet.getRow(1).font = { bold: true };
        peaksSheet.getRow(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF97306' }
        };
        peaksSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      }
    }
    
    const finalFileName = `${fileName}.xlsx`;
    
    // 导出文件
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = finalFileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
    
    alert(`Excel导出成功！\n\n文件名: ${finalFileName}\n\n包含工作表:\n• 源数据 - 原始电压和容量数据\n• ${typeLabels[type]}数据 - 差分计算结果\n• 峰信息 - 检测到的峰参数`);
    
    console.log('Excel导出成功:', finalFileName);
  } catch (error) {
    console.error('Excel导出失败:', error);
    alert('Excel导出失败: ' + (error as Error).message);
  }
}

// ==================== 曲线编辑功能 ====================

// 设置图表框选功能（支持三个图表）
function setupChartSelection(): void {
  const chartTypes: ('raw' | 'dqdv' | 'dvdq')[] = ['raw', 'dqdv', 'dvdq'];
  
  chartTypes.forEach(chartType => {
    const chart = state.charts[chartType];
    if (!chart) return;
    
    const canvas = chart.canvas;
    
    // 移除旧的事件监听器（如果有）
    canvas.onmousedown = null;
    canvas.onmousemove = null;
    canvas.onmouseup = null;
    canvas.onmouseleave = null;
    
    // 添加新的事件监听器
    canvas.onmousedown = (e) => {
      if (!state.editMode) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const xValue = xScale.getValueForPixel(x);
      const yValue = yScale.getValueForPixel(y);
      
      if (xValue !== null && xValue !== undefined && yValue !== null && yValue !== undefined) {
        state.selection.isSelecting = true;
        state.selection.chartType = chartType;
        state.selection.xStart = xValue;
        state.selection.xEnd = xValue;
        state.selection.yStart = yValue;
        state.selection.yEnd = yValue;
        
        // 显示当前图表的编辑提示
        showEditHint(chartType);
      }
    };
    
    canvas.onmousemove = (e) => {
      if (!state.editMode || !state.selection.isSelecting || state.selection.chartType !== chartType) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const xScale = chart.scales.x;
      const yScale = chart.scales.y;
      const xValue = xScale.getValueForPixel(x);
      const yValue = yScale.getValueForPixel(y);
      
      if (xValue !== null && xValue !== undefined) {
        state.selection.xEnd = xValue;
      }
      if (yValue !== null && yValue !== undefined) {
        state.selection.yEnd = yValue;
      }
      
      drawSelectionBox();
      updateSelectionInfo();
    };
    
    canvas.onmouseup = () => {
      if (!state.editMode || state.selection.chartType !== chartType) return;
      
      if (state.selection.isSelecting) {
        state.selection.isSelecting = false;
        updateEditButtons();
      }
    };
    
    canvas.onmouseleave = () => {
      if (state.selection.isSelecting && state.selection.chartType === chartType) {
        state.selection.isSelecting = false;
        updateEditButtons();
      }
    };
  });
}

// 显示编辑提示
function showEditHint(chartType: 'raw' | 'dqdv' | 'dvdq'): void {
  // 隐藏所有编辑提示
  document.getElementById('rawEditHint')?.classList.add('hidden');
  document.getElementById('dqdvEditHint')?.classList.add('hidden');
  document.getElementById('dvdqEditHint')?.classList.add('hidden');
}

// 绘制选择框（支持矩形框选）
function drawSelectionBox(): void {
  const chartType = state.selection.chartType;
  if (!chartType) return;
  
  const chart = state.charts[chartType];
  if (!chart || state.selection.xStart === null || state.selection.xEnd === null) return;
  
  // 查找或创建选择框数据集
  const existingIndex = chart.data.datasets.findIndex(ds => ds.label === '选择区域');
  if (existingIndex >= 0) {
    chart.data.datasets.splice(existingIndex, 1);
  }
  
  const xMin = Math.min(state.selection.xStart, state.selection.xEnd);
  const xMax = Math.max(state.selection.xStart, state.selection.xEnd);
  
  // 支持纵向选择（如果有y值）
  let yMin: number, yMax: number;
  if (state.selection.yStart !== null && state.selection.yEnd !== null) {
    yMin = Math.min(state.selection.yStart, state.selection.yEnd);
    yMax = Math.max(state.selection.yStart, state.selection.yEnd);
  } else {
    yMin = chart.scales.y.min;
    yMax = chart.scales.y.max;
  }
  
  // 添加选择框（使用背景色填充）
  chart.data.datasets.push({
    label: '选择区域',
    data: [
      { x: xMin, y: yMax },
      { x: xMax, y: yMax },
      { x: xMax, y: yMin },
      { x: xMin, y: yMin },
      { x: xMin, y: yMax },
    ],
    backgroundColor: 'rgba(255, 193, 7, 0.3)',
    borderColor: 'rgba(255, 193, 7, 1)',
    borderWidth: 2,
    fill: true,
    showLine: true,
    pointRadius: 0,
    order: 0,
  } as any);
  
  chart.update('none');
}

// 更新选择区域信息显示
function updateSelectionInfo(): void {
  const chartEl = document.getElementById('selectionChart');
  const xRangeEl = document.getElementById('selectionXRange');
  const yRangeEl = document.getElementById('selectionYRange');
  
  if (chartEl && state.selection.chartType) {
    const chartNames = { raw: '原始曲线', dqdv: 'dQ/dV', dvdq: 'dV/dQ' };
    chartEl.textContent = chartNames[state.selection.chartType];
  }
  
  if (xRangeEl && state.selection.xStart !== null && state.selection.xEnd !== null) {
    const xMin = Math.min(state.selection.xStart, state.selection.xEnd).toFixed(4);
    const xMax = Math.max(state.selection.xStart, state.selection.xEnd).toFixed(4);
    xRangeEl.textContent = `${xMin} ~ ${xMax}`;
  }
  
  if (yRangeEl && state.selection.yStart !== null && state.selection.yEnd !== null) {
    const yMin = Math.min(state.selection.yStart, state.selection.yEnd).toFixed(2);
    const yMax = Math.max(state.selection.yStart, state.selection.yEnd).toFixed(2);
    yRangeEl.textContent = `${yMin} ~ ${yMax}`;
  }
}

// 更新编辑按钮状态
function updateEditButtons(): void {
  const hasSelection = state.selection.xStart !== null && state.selection.xEnd !== null;
  const activeDataset = getActiveDataset();
  const hasEditedRanges = activeDataset && activeDataset.editedRanges.length > 0;
  
  const deleteBtn = document.getElementById('deleteSelection') as HTMLButtonElement;
  const colorBtn = document.getElementById('colorSelection') as HTMLButtonElement;
  const restoreBtn = document.getElementById('restoreSelection') as HTMLButtonElement;
  const restoreAllBtn = document.getElementById('restoreAllData') as HTMLButtonElement;
  
  if (deleteBtn) deleteBtn.disabled = !hasSelection;
  if (colorBtn) colorBtn.disabled = !hasSelection;
  if (restoreBtn) restoreBtn.disabled = !hasSelection;
  if (restoreAllBtn) restoreAllBtn.disabled = !hasEditedRanges;
}

// 清除选择
function clearSelection(): void {
  state.selection = {
    chartType: null,
    xStart: null,
    xEnd: null,
    yStart: null,
    yEnd: null,
    isSelecting: false,
  };
  
  // 清除所有图表的选择框
  ['raw', 'dqdv', 'dvdq'].forEach(chartType => {
    const chart = state.charts[chartType as 'raw' | 'dqdv' | 'dvdq'];
    if (chart) {
      const existingIndex = chart.data.datasets.findIndex(ds => ds.label === '选择区域');
      if (existingIndex >= 0) {
        chart.data.datasets.splice(existingIndex, 1);
        chart.update('none');
      }
    }
  });
  
  const chartEl = document.getElementById('selectionChart');
  const xRangeEl = document.getElementById('selectionXRange');
  const yRangeEl = document.getElementById('selectionYRange');
  
  if (chartEl) chartEl.textContent = '-';
  if (xRangeEl) xRangeEl.textContent = '-';
  if (yRangeEl) yRangeEl.textContent = '-';
  
  updateEditButtons();
}

// 删除选中区域的数据
function deleteSelectedRange(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset || state.selection.xStart === null || state.selection.xEnd === null || !state.selection.chartType) return;
  
  const chartType = state.selection.chartType;
  const xMin = Math.min(state.selection.xStart, state.selection.xEnd);
  const xMax = Math.max(state.selection.xStart, state.selection.xEnd);
  const yMin = state.selection.yStart !== null && state.selection.yEnd !== null 
    ? Math.min(state.selection.yStart, state.selection.yEnd) : null;
  const yMax = state.selection.yStart !== null && state.selection.yEnd !== null 
    ? Math.max(state.selection.yStart, state.selection.yEnd) : null;
  
  if (chartType === 'raw') {
    // 原始数据编辑
    // 根据数据类型和充电模式确定X轴和Y轴的数据
    const isCVMode = activeDataset.dataType === 'charge' && activeDataset.chargeMode === 'cv';
    const xData = activeDataset.capacity;  // X轴总是容量
    const yData = isCVMode ? activeDataset.current! : activeDataset.voltage;  // Y轴：CV模式是电流，其他是电压
    
    let startIdx = -1;
    let endIdx = -1;
    
    for (let i = 0; i < xData.length; i++) {
      const inXRange = xData[i] >= xMin && xData[i] <= xMax;
      const inYRange = yMin === null || yMax === null || 
        (yData[i] >= yMin && yData[i] <= yMax);
      
      if (inXRange && inYRange && startIdx === -1) {
        startIdx = i;
      }
      if (inXRange && inYRange) {
        endIdx = i;
      }
    }
    
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      alert('选择区域内没有有效数据');
      return;
    }
    
    // 记录编辑操作
    const editedRange: EditedRange = {
      id: `edit_${Date.now()}`,
      chartType: 'raw',
      startIndex: startIdx,
      endIndex: endIdx,
      action: 'deleted',
      xStart: xData[startIdx],
      xEnd: xData[endIdx],
      yStart: yMin !== null ? yData[startIdx] : undefined,
      yEnd: yMax !== null ? yData[endIdx] : undefined,
    };
    
    activeDataset.editedRanges.push(editedRange);
    
    // 从数据中删除该区域
    if (isCVMode) {
      // CV模式：删除电流和容量数据
      activeDataset.current!.splice(startIdx, endIdx - startIdx + 1);
      activeDataset.capacity.splice(startIdx, endIdx - startIdx + 1);
      if (activeDataset.cvData) {
        activeDataset.cvData.current.splice(startIdx, endIdx - startIdx + 1);
        activeDataset.cvData.capacity.splice(startIdx, endIdx - startIdx + 1);
      }
    } else {
      // 其他模式：删除电压和容量数据
      activeDataset.voltage.splice(startIdx, endIdx - startIdx + 1);
      activeDataset.capacity.splice(startIdx, endIdx - startIdx + 1);
    }
    
    // 清除差分结果
    activeDataset.differential = null;
    activeDataset.dqdi = null;
    activeDataset.peaks = { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] };
    
    alert(`已删除 ${endIdx - startIdx + 1} 个数据点`);
  } else if (chartType === 'dqdv' && activeDataset.differential) {
    // dQ/dV数据编辑 - 从差分数据中移除选中区域
    const dqdvData = activeDataset.differential;
    const indicesToRemove: number[] = [];
    
    for (let i = 0; i < dqdvData.voltage.length; i++) {
      const inXRange = dqdvData.voltage[i] >= xMin && dqdvData.voltage[i] <= xMax;
      const inYRange = yMin === null || yMax === null || 
        (dqdvData.dqdv[i] >= yMin && dqdvData.dqdv[i] <= yMax);
      
      if (inXRange && inYRange) {
        indicesToRemove.push(i);
      }
    }
    
    if (indicesToRemove.length === 0) {
      alert('选择区域内没有有效数据');
      return;
    }
    
    // 记录编辑操作
    const editedRange: EditedRange = {
      id: `edit_${Date.now()}`,
      chartType: 'dqdv',
      startIndex: indicesToRemove[0],
      endIndex: indicesToRemove[indicesToRemove.length - 1],
      action: 'deleted',
      xStart: dqdvData.voltage[indicesToRemove[0]],
      xEnd: dqdvData.voltage[indicesToRemove[indicesToRemove.length - 1]],
      yStart: yMin !== null ? yMin : undefined,
      yEnd: yMax !== null ? yMax : undefined,
    };
    
    activeDataset.editedRanges.push(editedRange);
    
    // 从差分数据中移除
    indicesToRemove.reverse().forEach(i => {
      dqdvData.voltage.splice(i, 1);
      dqdvData.dqdv.splice(i, 1);
      dqdvData.capacity.splice(i, 1);
      dqdvData.dvdq.splice(i, 1);
      dqdvData.fittedVoltage.splice(i, 1);
      dqdvData.fittedCapacity.splice(i, 1);
    });
    
    // 清除峰检测结果
    activeDataset.peaks.dqdv = [];
    
    alert(`已删除 dQ/dV 曲线中 ${indicesToRemove.length} 个数据点`);
  } else if (chartType === 'dvdq' && activeDataset.differential) {
    // dV/dQ数据编辑
    const dvdqData = activeDataset.differential;
    const indicesToRemove: number[] = [];
    
    for (let i = 0; i < dvdqData.capacity.length; i++) {
      const inXRange = dvdqData.capacity[i] >= xMin && dvdqData.capacity[i] <= xMax;
      const inYRange = yMin === null || yMax === null || 
        (dvdqData.dvdq[i] >= yMin && dvdqData.dvdq[i] <= yMax);
      
      if (inXRange && inYRange) {
        indicesToRemove.push(i);
      }
    }
    
    if (indicesToRemove.length === 0) {
      alert('选择区域内没有有效数据');
      return;
    }
    
    // 记录编辑操作
    const editedRange: EditedRange = {
      id: `edit_${Date.now()}`,
      chartType: 'dvdq',
      startIndex: indicesToRemove[0],
      endIndex: indicesToRemove[indicesToRemove.length - 1],
      action: 'deleted',
      xStart: dvdqData.capacity[indicesToRemove[0]],
      xEnd: dvdqData.capacity[indicesToRemove[indicesToRemove.length - 1]],
      yStart: yMin !== null ? yMin : undefined,
      yEnd: yMax !== null ? yMax : undefined,
    };
    
    activeDataset.editedRanges.push(editedRange);
    
    // 从差分数据中移除
    indicesToRemove.reverse().forEach(i => {
      dvdqData.capacity.splice(i, 1);
      dvdqData.dvdq.splice(i, 1);
      dvdqData.voltage.splice(i, 1);
      dvdqData.dqdv.splice(i, 1);
      dvdqData.fittedVoltage.splice(i, 1);
      dvdqData.fittedCapacity.splice(i, 1);
    });
    
    // 清除峰检测结果
    activeDataset.peaks.dvdq = [];
    
    alert(`已删除 dV/dQ 曲线中 ${indicesToRemove.length} 个数据点`);
  }
  
  // 更新图表
  updateAllCharts();
  updateEditHistory();
  clearSelection();
}

// 标注选中区域的颜色
function colorSelectedRange(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset || state.selection.xStart === null || state.selection.xEnd === null || !state.selection.chartType) return;
  
  const chartType = state.selection.chartType;
  const xMin = Math.min(state.selection.xStart, state.selection.xEnd);
  const xMax = Math.max(state.selection.xStart, state.selection.xEnd);
  const yMin = state.selection.yStart !== null && state.selection.yEnd !== null 
    ? Math.min(state.selection.yStart, state.selection.yEnd) : null;
  const yMax = state.selection.yStart !== null && state.selection.yEnd !== null 
    ? Math.max(state.selection.yStart, state.selection.yEnd) : null;
  
  // 获取选择的颜色
  const colorInput = document.getElementById('selectionColor') as HTMLInputElement;
  const color = colorInput?.value || '#ff6b6b';
  
  let startIdx = -1;
  let endIdx = -1;
  
  if (chartType === 'raw') {
    // 根据数据类型确定X轴数据
    const isCVMode = activeDataset.dataType === 'charge' && activeDataset.chargeMode === 'cv';
    const xData = activeDataset.capacity;  // X轴总是容量
    
    for (let i = 0; i < xData.length; i++) {
      if (xData[i] >= xMin && startIdx === -1) {
        startIdx = i;
      }
      if (xData[i] <= xMax) {
        endIdx = i;
      }
    }
  } else if (chartType === 'dqdv' && activeDataset.differential) {
    for (let i = 0; i < activeDataset.differential.voltage.length; i++) {
      if (activeDataset.differential.voltage[i] >= xMin && startIdx === -1) {
        startIdx = i;
      }
      if (activeDataset.differential.voltage[i] <= xMax) {
        endIdx = i;
      }
    }
  } else if (chartType === 'dvdq' && activeDataset.differential) {
    for (let i = 0; i < activeDataset.differential.capacity.length; i++) {
      if (activeDataset.differential.capacity[i] >= xMin && startIdx === -1) {
        startIdx = i;
      }
      if (activeDataset.differential.capacity[i] <= xMax) {
        endIdx = i;
      }
    }
  }
  
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    alert('选择区域内没有有效数据');
    return;
  }
  
  // 记录编辑操作
  const editedRange: EditedRange = {
    id: `edit_${Date.now()}`,
    chartType: chartType,
    startIndex: startIdx,
    endIndex: endIdx,
    action: 'colored',
    color: color,
    xStart: xMin,
    xEnd: xMax,
    yStart: yMin !== null ? yMin : undefined,
    yEnd: yMax !== null ? yMax : undefined,
  };
  
  activeDataset.editedRanges.push(editedRange);
  
  // 更新图表显示颜色区域
  updateAllCharts();
  updateEditHistory();
  clearSelection();
  
  alert(`已标注区域 (X: ${xMin.toFixed(4)} ~ ${xMax.toFixed(4)})`);
}

// 恢复选中区域
function restoreSelectedRange(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset || !activeDataset.originalData || state.selection.xStart === null || state.selection.xEnd === null) return;
  
  const xMin = Math.min(state.selection.xStart, state.selection.xEnd);
  const xMax = Math.max(state.selection.xStart, state.selection.xEnd);
  
  // 在原始数据中找到对应的数据点
  const restoredVoltage: number[] = [];
  const restoredCapacity: number[] = [];
  
  for (let i = 0; i < activeDataset.originalData.voltage.length; i++) {
    const v = activeDataset.originalData.voltage[i];
    if (v >= xMin && v <= xMax) {
      // 检查是否已经在当前数据中
      if (!activeDataset.voltage.includes(v)) {
        restoredVoltage.push(v);
        restoredCapacity.push(activeDataset.originalData.capacity[i]);
      }
    }
  }
  
  if (restoredVoltage.length === 0) {
    alert('选择区域没有可恢复的数据');
    return;
  }
  
  // 将恢复的数据插入到正确位置
  const allVoltage = [...activeDataset.voltage, ...restoredVoltage];
  const allCapacity = [...activeDataset.capacity, ...restoredCapacity];
  
  // 排序
  const indices = allVoltage.map((_, i) => i);
  indices.sort((a, b) => allVoltage[a] - allVoltage[b]);
  
  activeDataset.voltage = indices.map(i => allVoltage[i]);
  activeDataset.capacity = indices.map(i => allCapacity[i]);
  
  // 清除差分结果
  activeDataset.differential = null;
  activeDataset.peaks = { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] };
  
  // 移除该范围内的编辑记录
  activeDataset.editedRanges = activeDataset.editedRanges.filter(r => 
    !(r.xStart >= xMin && r.xEnd <= xMax)
  );
  
  updateAllCharts();
  updateEditHistory();
  clearSelection();
  
  alert(`已恢复 ${restoredVoltage.length} 个数据点`);
}

// 恢复全部数据
function restoreAllData(): void {
  const activeDataset = getActiveDataset();
  if (!activeDataset || !activeDataset.originalData) return;
  
  if (!confirm('确定要恢复所有数据到原始状态吗？这将撤销所有编辑操作。')) {
    return;
  }
  
  // 恢复原始数据
  activeDataset.voltage = [...activeDataset.originalData.voltage];
  activeDataset.capacity = [...activeDataset.originalData.capacity];
  activeDataset.editedRanges = [];
  
  // 清除差分结果
  activeDataset.differential = null;
  activeDataset.peaks = { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] };
  
  updateAllCharts();
  updateEditHistory();
  clearSelection();
  
  alert('已恢复所有数据到原始状态');
}

// 点选删除相关
let pointDeleteClickHandler: ((e: MouseEvent) => void) | null = null;

function setupPointDelete(): void {
  const canvas = document.getElementById('rawChart') as HTMLCanvasElement;
  if (!canvas) return;
  
  pointDeleteClickHandler = (e: MouseEvent) => {
    if (!state.pointDeleteMode) return;
    
    const activeDataset = getActiveDataset();
    if (!activeDataset) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const chart = state.charts.raw;
    if (!chart) return;
    
    // 获取点击位置对应的图表坐标
    const xScale = chart.scales.x;
    const yScale = chart.scales.y;
    const chartX = xScale.getValueForPixel(x);
    const chartY = yScale.getValueForPixel(y);
    
    if (chartX === null || chartY === null) return;
    
    // 找到最近的数据点
    const isCVMode = activeDataset.dataType === 'charge' && activeDataset.chargeMode === 'cv';
    const xData = activeDataset.capacity;
    const yData = isCVMode ? activeDataset.current! : activeDataset.voltage;
    
    let minDist = Infinity;
    let nearestIdx = -1;
    
    // 计算点击位置到数据点的距离（像素单位）
    for (let i = 0; i < xData.length; i++) {
      const px = xScale.getPixelForValue(xData[i]);
      const py = yScale.getPixelForValue(yData[i]);
      const dist = Math.sqrt(Math.pow(px - x, 2) + Math.pow(py - y, 2));
      
      if (dist < minDist && dist < 20) {  // 20像素阈值
        minDist = dist;
        nearestIdx = i;
      }
    }
    
    if (nearestIdx >= 0) {
      // 确认删除
      if (confirm(`确定要删除数据点 #${nearestIdx + 1} 吗？\n容量: ${xData[nearestIdx].toFixed(4)}\n${isCVMode ? '电流' : '电压'}: ${yData[nearestIdx].toFixed(4)}`)) {
        // 记录编辑操作
        const editedRange: EditedRange = {
          id: `edit_${Date.now()}`,
          chartType: 'raw',
          startIndex: nearestIdx,
          endIndex: nearestIdx,
          action: 'deleted',
          xStart: xData[nearestIdx],
          xEnd: xData[nearestIdx],
        };
        activeDataset.editedRanges.push(editedRange);
        
        // 删除数据点
        if (isCVMode) {
          activeDataset.current!.splice(nearestIdx, 1);
          activeDataset.capacity.splice(nearestIdx, 1);
          if (activeDataset.cvData) {
            activeDataset.cvData.current.splice(nearestIdx, 1);
            activeDataset.cvData.capacity.splice(nearestIdx, 1);
          }
        } else {
          activeDataset.voltage.splice(nearestIdx, 1);
          activeDataset.capacity.splice(nearestIdx, 1);
        }
        
        // 清除差分结果
        activeDataset.differential = null;
        activeDataset.dqdi = null;
        activeDataset.peaks = { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] };
        
        updateAllCharts();
        updateEditHistory();
      }
    }
  };
  
  canvas.addEventListener('click', pointDeleteClickHandler);
  canvas.style.cursor = 'crosshair';
}

function removePointDelete(): void {
  const canvas = document.getElementById('rawChart') as HTMLCanvasElement;
  if (!canvas) return;
  
  if (pointDeleteClickHandler) {
    canvas.removeEventListener('click', pointDeleteClickHandler);
    pointDeleteClickHandler = null;
  }
  canvas.style.cursor = 'default';
}

// 更新编辑历史显示
function updateEditHistory(): void {
  const activeDataset = getActiveDataset();
  const historyList = document.getElementById('editHistoryList');
  
  if (!historyList || !activeDataset) return;
  
  if (activeDataset.editedRanges.length === 0) {
    historyList.innerHTML = '<div class="text-gray-400">暂无编辑记录</div>';
    return;
  }
  
  const chartNames = { raw: '原始', dqdv: 'dQ/dV', dvdq: 'dV/dQ' };
  
  historyList.innerHTML = activeDataset.editedRanges.map((range) => {
    const actionText = range.action === 'deleted' ? '删除' : '标注';
    const actionColor = range.action === 'deleted' ? 'text-red-600' : 'text-purple-600';
    const colorBox = range.color ? `<span class="inline-block w-3 h-3 rounded ml-1" style="background-color: ${range.color}"></span>` : '';
    const chartName = chartNames[range.chartType];
    
    return `<div class="flex items-center justify-between py-0.5 border-b border-gray-200 last:border-0">
      <span class="${actionColor}">[${chartName}] ${actionText}: ${range.xStart.toFixed(3)} ~ ${range.xEnd.toFixed(3)} ${colorBox}</span>
      <button onclick="undoEdit('${range.id}')" class="text-xs text-blue-500 hover:text-blue-700">撤销</button>
    </div>`;
  }).join('');
}

// 撤销编辑操作
(window as any).undoEdit = (editId: string) => {
  const activeDataset = getActiveDataset();
  if (!activeDataset || !activeDataset.originalData) return;
  
  const editIndex = activeDataset.editedRanges.findIndex(r => r.id === editId);
  if (editIndex === -1) return;
  
  const edit = activeDataset.editedRanges[editIndex];
  
  if (edit.action === 'deleted') {
    // 恢复被删除的数据
    const restoredVoltage: number[] = [];
    const restoredCapacity: number[] = [];
    
    for (let i = edit.startIndex; i < Math.min(edit.endIndex + 1, activeDataset.originalData.voltage.length); i++) {
      restoredVoltage.push(activeDataset.originalData.voltage[i]);
      restoredCapacity.push(activeDataset.originalData.capacity[i]);
    }
    
    // 合并并排序
    const allVoltage = [...activeDataset.voltage, ...restoredVoltage];
    const allCapacity = [...activeDataset.capacity, ...restoredCapacity];
    const indices = allVoltage.map((_, i) => i);
    indices.sort((a, b) => allVoltage[a] - allVoltage[b]);
    
    activeDataset.voltage = indices.map(i => allVoltage[i]);
    activeDataset.capacity = indices.map(i => allCapacity[i]);
  }
  
  // 移除该编辑记录
  activeDataset.editedRanges.splice(editIndex, 1);
  
  // 清除差分结果
  activeDataset.differential = null;
  activeDataset.peaks = { dqdv: [], dvdq: [], dsocdv: [], dqdi: [] };
  
  updateAllCharts();
  updateEditHistory();
};

// 更新所有图表
function updateAllCharts(): void {
  const visibleDatasets = state.datasets.filter(ds => ds.visible && ds.differential);
  updateRawChart(state.datasets);
  // 原有图表
  updateDqdvChart(state.datasets);
  updateDvdqChart(state.datasets);
  updateDsocdvChart(visibleDatasets);
  // 更新新增曲线图表
  updateDqdvQChart(visibleDatasets);
  updateDqdvSocChart(visibleDatasets);
  updateDvdqVChart(visibleDatasets);
  updateDvdqSocChart(visibleDatasets);
  updateDsocdvQChart(visibleDatasets);
  updateDsocdvSocChart(visibleDatasets);
  updateEditButtons();
}
