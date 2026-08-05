/**
 * 差分计算工具函数
 * 基于曲线拟合的差分分析方法
 */

import {
  polynomialFit,
  polynomialEvaluate,
  polynomialDerivative,
  BSpline,
  CubicSpline,
  GaussianProcess,
  loessFit,
} from './fitting';

export interface DifferentialResult {
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
  // 改进方法的独立数据点
  dqdvVoltage?: number[];
  dvdqCapacity?: number[];
  // 新增曲线数据
  // SOC 数组（归一化容量 0-1）
  soc: number[];
  // dQ/dV vs Q（容量）
  dqdvQ: number[];       // dQ/dV 值
  dqdvCapacity: number[]; // 对应的容量点
  // dQ/dV vs SOC
  dqdvSoc: number[];     // dQ/dV 值
  dqdvSocX: number[];    // 对应的SOC点
  // dV/dQ vs V（电压）
  dvdqV: number[];       // dV/dQ 值
  dvdqVoltage: number[]; // 对应的电压点
  // dV/dQ vs SOC
  dvdqSoc: number[];     // dV/dQ 值
  dvdqSocX: number[];    // 对应的SOC点
  // dSOC/dV vs Q（容量）
  dsocdvQ: number[];       // dSOC/dV 值
  dsocdvCapacity: number[]; // 对应的容量点
  // dSOC/dV vs SOC
  dsocdvSoc: number[];     // dSOC/dV 值
  dsocdvSocX: number[];    // 对应的SOC点
  // V vs SOC（电压随SOC变化曲线）
  vSoc: number[];          // 电压值
  vSocX: number[];         // 对应的SOC点
}

/**
 * dQ/dI 分析结果（恒压充电模式下的差分电流分析）
 * 基于论文: Ko et al. (2024) - Differential current in constant-voltage charging mode
 */
export interface DqdiResult {
  current: number[];      // 电流数组 (A)
  capacity: number[];     // 容量数组 (Ah)
  time: number[];         // 时间数组 (s)
  dqdi: number[];         // dQ/dI 值 (Ah/A)
  fittedCurrent: number[];  // 拟合后的电流
  fittedCapacity: number[]; // 拟合后的容量
  uniformCurrent: number[]; // 均匀电流网格
  // dQ/dI vs I 曲线
  dqdiCurrent: number[];  // 对应的电流点
  dqdiValue: number[];    // dQ/dI 值
  // dI/dQ vs Q 曲线
  didqCapacity: number[]; // 对应的容量点
  didqValue: number[];    // dI/dQ 值
  maxCurrent: number;     // 最大电流（用于归一化）
  totalCapacity: number;  // CV阶段总容量
}

export type FittingMethod = 'polynomial' | 'spline' | 'bspline' | 'loess' | 'gaussian';

export type DifferentialMethod = 'analytical' | 'numerical_center' | 'numerical_forward' | 'numerical_backward' | 'improved' | 'robust';

export interface DifferentialParams {
  method: DifferentialMethod;
  windowSize: number;
  enableSmoothing: boolean;
  smoothingMethod: 'moving_average' | 'savitzky_golay' | 'gaussian';
  smoothingWindow: number;
  smoothingSigma: number;
  // dQ/dI I-Q曲线拟合参数
  fittingMethod?: 'polynomial' | 'spline' | 'bspline' | 'exponential';
  fittingDegree?: number;
  showFittedCurve?: boolean;
  // 改进方法的额外参数
  enablePreFilter?: boolean;
  preFilterMethod?: 'moving_average' | 'savitzky_golay' | 'gaussian';
  preFilterWindow?: number;
  preFilterSigma?: number;
  voltageInterpolationPoints?: number; // 电压插值点数
}

export interface FittingParams {
  method: FittingMethod;
  polynomialDegree: number;
  bsplineDegree: number;
  bsplineKnots: number;
  loessSpan: number;
  loessDegree: number;
  gpLengthScale: number;
  gpSigmaF: number;
  gpSigmaN: number;
  numPoints: number;
}

// 单独的差分参数配置
export interface SeparateDiffParams {
  dqdv: DifferentialParams;
  dvdq: DifferentialParams;
}

/**
 * 对数据进行排序和去重（按电压排序，用于Q(V)拟合）
 */
function sortAndUniqueData(
  voltage: number[],
  capacity: number[]
): { voltage: number[]; capacity: number[] } {
  const indices = voltage.map((_, i) => i);
  indices.sort((a, b) => voltage[a] - voltage[b]);

  const sortedVoltage: number[] = [];
  const sortedCapacity: number[] = [];
  const seen = new Set<number>();

  for (const i of indices) {
    const v = Math.round(voltage[i] * 100000) / 100000;

    if (!seen.has(v)) {
      seen.add(v);
      sortedVoltage.push(voltage[i]);
      sortedCapacity.push(capacity[i]);
    }
  }

  return { voltage: sortedVoltage, capacity: sortedCapacity };
}

/**
 * 对数据进行排序和去重（按容量排序，用于V(Q)拟合）
 */
function sortAndUniqueDataByCapacity(
  voltage: number[],
  capacity: number[]
): { voltage: number[]; capacity: number[] } {
  const indices = capacity.map((_, i) => i);
  indices.sort((a, b) => capacity[a] - capacity[b]);

  const sortedVoltage: number[] = [];
  const sortedCapacity: number[] = [];
  const seen = new Set<number>();

  for (const i of indices) {
    const c = Math.round(capacity[i] * 100000) / 100000;

    if (!seen.has(c)) {
      seen.add(c);
      sortedVoltage.push(voltage[i]);
      sortedCapacity.push(capacity[i]);
    }
  }

  return { voltage: sortedVoltage, capacity: sortedCapacity };
}

/**
 * 创建均匀网格
 */
function createUniformGrid(min: number, max: number, numPoints: number): number[] {
  const grid: number[] = [];
  const step = (max - min) / (numPoints - 1);
  for (let i = 0; i < numPoints; i++) {
    grid.push(min + i * step);
  }
  return grid;
}

/**
 * 数值差分 - 中心差分
 */
function numericalDerivativeCenter(y: number[], x: number[]): number[] {
  const n = y.length;
  const result: number[] = [];
  
  result.push((y[1] - y[0]) / (x[1] - x[0]));
  
  for (let i = 1; i < n - 1; i++) {
    result.push((y[i + 1] - y[i - 1]) / (x[i + 1] - x[i - 1]));
  }
  
  result.push((y[n - 1] - y[n - 2]) / (x[n - 1] - x[n - 2]));
  
  return result;
}

/**
 * 数值差分 - 前向差分
 */
function numericalDerivativeForward(y: number[], x: number[]): number[] {
  const n = y.length;
  const result: number[] = [];
  
  for (let i = 0; i < n - 1; i++) {
    result.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  }
  result.push(result[result.length - 1]);
  
  return result;
}

/**
 * 数值差分 - 后向差分
 */
function numericalDerivativeBackward(y: number[], x: number[]): number[] {
  const n = y.length;
  const result: number[] = [];
  
  result.push(0);
  
  for (let i = 1; i < n; i++) {
    result.push((y[i] - y[i - 1]) / (x[i] - x[i - 1]));
  }
  result[0] = result[1];
  
  return result;
}

/**
 * 多点差分（窗口平滑差分）
 */
function numericalDerivativeWindowed(y: number[], x: number[], windowSize: number): number[] {
  const n = y.length;
  const result: number[] = [];
  const halfWindow = Math.floor(windowSize / 2);
  
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - halfWindow);
    const end = Math.min(n - 1, i + halfWindow);
    
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    let count = 0;
    
    for (let j = start; j <= end; j++) {
      sumX += x[j];
      sumY += y[j];
      sumXY += x[j] * y[j];
      sumX2 += x[j] * x[j];
      count++;
    }
    
    const slope = (count * sumXY - sumX * sumY) / (count * sumX2 - sumX * sumX);
    result.push(isFinite(slope) ? slope : 0);
  }
  
  return result;
}

/**
 * 移动平均平滑
 */
function movingAverage(data: number[], windowSize: number): number[] {
  const n = data.length;
  const result: number[] = [];
  const half = Math.floor(windowSize / 2);
  
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      sum += data[j];
      count++;
    }
    
    result.push(sum / count);
  }
  
  return result;
}

/**
 * Savitzky-Golay 平滑（简化版）
 */
function savitzkyGolaySmooth(data: number[], windowSize: number): number[] {
  const n = data.length;
  const result: number[] = [];
  const half = Math.floor(windowSize / 2);
  
  const sgCoeffs: { [key: number]: number[] } = {
    3: [1, 2, 1].map(c => c / 4),
    5: [-3, 12, 17, 12, -3].map(c => c / 35),
    7: [-2, 3, 6, 7, 6, 3, -2].map(c => c / 21),
    9: [-21, 14, 39, 54, 59, 54, 39, 14, -21].map(c => c / 231),
    11: [-36, 9, 44, 69, 84, 89, 84, 69, 44, 9, -36].map(c => c / 429),
    13: [-11, 0, 9, 16, 21, 24, 25, 24, 21, 16, 9, 0, -11].map(c => c / 143),
    15: [-78, -13, 42, 87, 122, 147, 162, 167, 162, 147, 122, 87, 42, -13, -78].map(c => c / 1105),
    17: [-21, -6, 7, 18, 27, 34, 39, 42, 43, 42, 39, 34, 27, 18, 7, -6, -21].map(c => c / 323),
    19: [-136, -51, 24, 89, 144, 189, 224, 249, 264, 269, 264, 249, 224, 189, 144, 89, 24, -51, -136].map(c => c / 2261),
    21: [-171, -76, 9, 84, 149, 204, 249, 284, 309, 324, 329, 324, 309, 284, 249, 204, 149, 84, 9, -76, -171].map(c => c / 3059),
  };
  
  // 选择最接近的窗口大小的系数
  let coeffs = sgCoeffs[windowSize];
  if (!coeffs) {
    const sizes = Object.keys(sgCoeffs).map(Number).sort((a, b) => a - b);
    const closest = sizes.reduce((prev, curr) => 
      Math.abs(curr - windowSize) < Math.abs(prev - windowSize) ? curr : prev
    );
    coeffs = sgCoeffs[closest];
  }
  
  for (let i = 0; i < n; i++) {
    let sum = 0;
    
    for (let j = 0; j < coeffs.length; j++) {
      const idx = i - half + j;
      if (idx >= 0 && idx < n) {
        sum += coeffs[j] * data[idx];
      } else {
        const mirrorIdx = idx < 0 ? -idx : 2 * n - idx - 2;
        if (mirrorIdx >= 0 && mirrorIdx < n) {
          sum += coeffs[j] * data[mirrorIdx];
        }
      }
    }
    
    result.push(sum);
  }
  
  return result;
}

/**
 * 高斯平滑
 */
function gaussianSmooth(data: number[], sigma: number): number[] {
  const n = data.length;
  const result: number[] = [];
  const kernelSize = Math.ceil(sigma * 3) * 2 + 1;
  const half = Math.floor(kernelSize / 2);
  
  const kernel: number[] = [];
  let kernelSum = 0;
  
  for (let i = -half; i <= half; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(weight);
    kernelSum += weight;
  }
  
  const normalizedKernel = kernel.map(k => k / kernelSum);
  
  for (let i = 0; i < n; i++) {
    let sum = 0;
    
    for (let j = 0; j < kernelSize; j++) {
      const idx = i - half + j;
      if (idx >= 0 && idx < n) {
        sum += normalizedKernel[j] * data[idx];
      } else {
        const mirrorIdx = idx < 0 ? -idx : 2 * n - idx - 2;
        if (mirrorIdx >= 0 && mirrorIdx < n) {
          sum += normalizedKernel[j] * data[mirrorIdx];
        }
      }
    }
    
    result.push(sum);
  }
  
  return result;
}

/**
 * 应用平滑
 */
function applySmoothing(
  data: number[],
  params: DifferentialParams
): number[] {
  if (!params.enableSmoothing) return data;
  
  switch (params.smoothingMethod) {
    case 'moving_average':
      return movingAverage(data, params.smoothingWindow);
    case 'savitzky_golay':
      return savitzkyGolaySmooth(data, params.smoothingWindow);
    case 'gaussian':
      return gaussianSmooth(data, params.smoothingSigma);
    default:
      return data;
  }
}

/**
 * 五点差分法（更精确的数值微分）
 */
function fivePointDerivative(y: number[], x: number[]): number[] {
  const n = y.length;
  const result: number[] = [];
  
  // 前两个点使用简单差分
  if (n >= 2) {
    result.push((y[1] - y[0]) / (x[1] - x[0]));
  }
  if (n >= 3) {
    result.push((y[2] - y[0]) / (x[2] - x[0]));
  }
  
  // 中间点使用五点差分公式
  for (let i = 2; i < n - 2; i++) {
    const h1 = x[i] - x[i-1];
    const h2 = x[i+1] - x[i];
    const h = (h1 + h2) / 2;
    
    // 五点差分公式
    const deriv = (-y[i+2] + 8*y[i+1] - 8*y[i-1] + y[i-2]) / (12 * h);
    result.push(deriv);
  }
  
  // 后两个点
  if (n >= 4) {
    result.push((y[n-1] - y[n-3]) / (x[n-1] - x[n-3]));
  }
  if (n >= 2) {
    result.push((y[n-1] - y[n-2]) / (x[n-1] - x[n-2]));
  }
  
  return result;
}

/**
 * 改进的dV/dQ计算方法
 * 特点：
 * 1. 基于电压等距插值
 * 2. 可选预滤波
 * 3. 使用五点差分或中心差分
 * 4. 后滤波平滑
 */
function calculateImprovedDvdq(
  voltage: number[],
  capacity: number[],
  params: DifferentialParams
): { capacity: number[]; dvdq: number[] } {
  const n = voltage.length;
  
  // 1. 预滤波（可选）
  let filteredVoltage = [...voltage];
  let filteredCapacity = [...capacity];
  
  if (params.enablePreFilter) {
    switch (params.preFilterMethod) {
      case 'moving_average':
        filteredVoltage = movingAverage(voltage, params.preFilterWindow || 5);
        filteredCapacity = movingAverage(capacity, params.preFilterWindow || 5);
        break;
      case 'savitzky_golay':
        filteredVoltage = savitzkyGolaySmooth(voltage, params.preFilterWindow || 5);
        filteredCapacity = savitzkyGolaySmooth(capacity, params.preFilterWindow || 5);
        break;
      case 'gaussian':
        filteredVoltage = gaussianSmooth(voltage, params.preFilterSigma || 1);
        filteredCapacity = gaussianSmooth(capacity, params.preFilterSigma || 1);
        break;
    }
  }
  
  // 2. 按容量排序（用于dV/dQ计算）
  const indices = filteredCapacity.map((_, i) => i);
  indices.sort((a, b) => filteredCapacity[a] - filteredCapacity[b]);
  
  const sortedCapacity: number[] = [];
  const sortedVoltage: number[] = [];
  const seen = new Set<number>();
  
  for (const i of indices) {
    const c = Math.round(filteredCapacity[i] * 1000000) / 1000000;
    if (!seen.has(c)) {
      seen.add(c);
      sortedCapacity.push(filteredCapacity[i]);
      sortedVoltage.push(filteredVoltage[i]);
    }
  }
  
  // 3. 创建等距容量网格
  const numPoints = params.voltageInterpolationPoints || Math.min(500, sortedCapacity.length);
  const cMin = sortedCapacity[0];
  const cMax = sortedCapacity[sortedCapacity.length - 1];
  const uniformCapacity = createUniformGrid(cMin, cMax, numPoints);
  
  // 4. 使用三次样条插值到等距容量点
  const spline = new CubicSpline(sortedCapacity, sortedVoltage);
  const interpolatedVoltage = uniformCapacity.map(c => spline.evaluate(c));
  
  // 5. 计算导数
  let dvdq: number[];
  
  // 使用五点差分（更精确）或窗口差分
  if (params.windowSize <= 1) {
    dvdq = fivePointDerivative(interpolatedVoltage, uniformCapacity);
  } else {
    dvdq = numericalDerivativeWindowed(interpolatedVoltage, uniformCapacity, params.windowSize);
  }
  
  // 6. 后滤波平滑
  if (params.enableSmoothing) {
    dvdq = applySmoothing(dvdq, params);
  }
  
  return {
    capacity: uniformCapacity,
    dvdq: dvdq
  };
}

/**
 * 改进的dQ/dV计算方法
 */
function calculateImprovedDqdv(
  voltage: number[],
  capacity: number[],
  params: DifferentialParams
): { voltage: number[]; dqdv: number[] } {
  const n = voltage.length;
  
  // 1. 预滤波（可选）
  let filteredVoltage = [...voltage];
  let filteredCapacity = [...capacity];
  
  if (params.enablePreFilter) {
    switch (params.preFilterMethod) {
      case 'moving_average':
        filteredVoltage = movingAverage(voltage, params.preFilterWindow || 5);
        filteredCapacity = movingAverage(capacity, params.preFilterWindow || 5);
        break;
      case 'savitzky_golay':
        filteredVoltage = savitzkyGolaySmooth(voltage, params.preFilterWindow || 5);
        filteredCapacity = savitzkyGolaySmooth(capacity, params.preFilterWindow || 5);
        break;
      case 'gaussian':
        filteredVoltage = gaussianSmooth(voltage, params.preFilterSigma || 1);
        filteredCapacity = gaussianSmooth(capacity, params.preFilterSigma || 1);
        break;
    }
  }
  
  // 2. 按电压排序（用于dQ/dV计算）
  const indices = filteredVoltage.map((_, i) => i);
  indices.sort((a, b) => filteredVoltage[a] - filteredVoltage[b]);
  
  const sortedVoltage: number[] = [];
  const sortedCapacity: number[] = [];
  const seen = new Set<number>();
  
  for (const i of indices) {
    const v = Math.round(filteredVoltage[i] * 1000000) / 1000000;
    if (!seen.has(v)) {
      seen.add(v);
      sortedVoltage.push(filteredVoltage[i]);
      sortedCapacity.push(filteredCapacity[i]);
    }
  }
  
  // 3. 创建等距电压网格
  const numPoints = params.voltageInterpolationPoints || Math.min(500, sortedVoltage.length);
  const vMin = sortedVoltage[0];
  const vMax = sortedVoltage[sortedVoltage.length - 1];
  const uniformVoltage = createUniformGrid(vMin, vMax, numPoints);
  
  // 4. 使用三次样条插值到等距电压点
  const spline = new CubicSpline(sortedVoltage, sortedCapacity);
  const interpolatedCapacity = uniformVoltage.map(v => spline.evaluate(v));
  
  // 5. 计算导数
  let dqdv: number[];
  
  // 使用五点差分（更精确）或窗口差分
  if (params.windowSize <= 1) {
    dqdv = fivePointDerivative(interpolatedCapacity, uniformVoltage);
  } else {
    dqdv = numericalDerivativeWindowed(interpolatedCapacity, uniformVoltage, params.windowSize);
  }
  
  // 6. 后滤波平滑
  if (params.enableSmoothing) {
    dqdv = applySmoothing(dqdv, params);
  }
  
  return {
    voltage: uniformVoltage,
    dqdv: dqdv
  };
}

/**
 * 计算数值导数
 */
function computeNumericalDerivative(
  y: number[],
  x: number[],
  params: DifferentialParams
): number[] {
  let result: number[];
  
  switch (params.method) {
    case 'numerical_center':
      if (params.windowSize > 1) {
        result = numericalDerivativeWindowed(y, x, params.windowSize);
      } else {
        result = numericalDerivativeCenter(y, x);
      }
      break;
    case 'numerical_forward':
      result = numericalDerivativeForward(y, x);
      break;
    case 'numerical_backward':
      result = numericalDerivativeBackward(y, x);
      break;
    case 'improved':
      // 使用五点差分法
      result = fivePointDerivative(y, x);
      break;
    default:
      result = numericalDerivativeCenter(y, x);
  }
  
  return result;
}

/**
 * 基于拟合的差分计算（分开参数）
 */
export function calculateDifferential(
  voltage: number[],
  capacity: number[],
  fittingParams: FittingParams,
  diffParams: SeparateDiffParams
): DifferentialResult {
  if (voltage.length !== capacity.length) {
    throw new Error('电压和容量数据长度不一致');
  }

  if (voltage.length < 5) {
    throw new Error('数据点太少，至少需要5个点');
  }

  // 按电压排序（用于 Q(V) 拟合）
  const { voltage: sortedVoltage, capacity: sortedCapacity } = sortAndUniqueData(
    voltage,
    capacity
  );

  // 按容量排序（用于 V(Q) 拟合）
  const { voltage: sortedVoltageByC, capacity: sortedCapacityByC } = sortAndUniqueDataByCapacity(
    voltage,
    capacity
  );

  // 创建均匀网格
  const vMin = Math.min(...sortedVoltage);
  const vMax = Math.max(...sortedVoltage);
  const cMin = Math.min(...sortedCapacityByC);
  const cMax = Math.max(...sortedCapacityByC);

  const uniformVoltage = createUniformGrid(vMin, vMax, fittingParams.numPoints);
  const uniformCapacity = createUniformGrid(cMin, cMax, fittingParams.numPoints);

  // 拟合
  let fittedCapacity: number[];
  let fittedVoltage: number[];
  
  let splineQ: CubicSpline | null = null;
  let splineV: CubicSpline | null = null;
  let bsplineQ: BSpline | null = null;
  let bsplineV: BSpline | null = null;
  let gpQ: GaussianProcess | null = null;
  let gpV: GaussianProcess | null = null;
  let polyCoeffsQ: number[] | null = null;
  let polyCoeffsV: number[] | null = null;

  switch (fittingParams.method) {
    case 'polynomial': {
      polyCoeffsQ = polynomialFit(sortedVoltage, sortedCapacity, fittingParams.polynomialDegree);
      polyCoeffsV = polynomialFit(sortedCapacityByC, sortedVoltageByC, fittingParams.polynomialDegree);
      fittedCapacity = uniformVoltage.map(v => polynomialEvaluate(polyCoeffsQ!, v));
      fittedVoltage = uniformCapacity.map(c => polynomialEvaluate(polyCoeffsV!, c));
      break;
    }

    case 'spline': {
      splineQ = new CubicSpline(sortedVoltage, sortedCapacity);
      splineV = new CubicSpline(sortedCapacityByC, sortedVoltageByC);
      fittedCapacity = uniformVoltage.map(v => splineQ!.evaluate(v));
      fittedVoltage = uniformCapacity.map(c => splineV!.evaluate(c));
      break;
    }

    case 'bspline': {
      bsplineQ = new BSpline(sortedVoltage, sortedCapacity, fittingParams.bsplineDegree, fittingParams.bsplineKnots);
      bsplineV = new BSpline(sortedCapacityByC, sortedVoltageByC, fittingParams.bsplineDegree, fittingParams.bsplineKnots);
      fittedCapacity = uniformVoltage.map(v => bsplineQ!.evaluate(v));
      fittedVoltage = uniformCapacity.map(c => bsplineV!.evaluate(c));
      break;
    }

    case 'loess': {
      fittedCapacity = loessFit(sortedVoltage, sortedCapacity, uniformVoltage, fittingParams.loessSpan, fittingParams.loessDegree);
      fittedVoltage = loessFit(sortedCapacityByC, sortedVoltageByC, uniformCapacity, fittingParams.loessSpan, fittingParams.loessDegree);
      break;
    }

    case 'gaussian': {
      gpQ = new GaussianProcess(sortedVoltage, sortedCapacity, fittingParams.gpLengthScale, fittingParams.gpSigmaF, fittingParams.gpSigmaN);
      gpV = new GaussianProcess(sortedCapacityByC, sortedVoltageByC, fittingParams.gpLengthScale, fittingParams.gpSigmaF, fittingParams.gpSigmaN);
      fittedCapacity = uniformVoltage.map(v => gpQ!.evaluate(v));
      fittedVoltage = uniformCapacity.map(c => gpV!.evaluate(c));
      break;
    }

    default:
      throw new Error(`未知的拟合方法: ${fittingParams.method}`);
  }

  // 计算 dQ/dV（使用 dqdv 的参数）
  let dqdv: number[];
  let dqdvVoltage = uniformVoltage;
  const dqdvParams = diffParams.dqdv;
  
  // 如果使用改进方法，则调用改进的dQ/dV计算
  if (dqdvParams.method === 'improved') {
    const improvedResult = calculateImprovedDqdv(sortedVoltage, sortedCapacity, dqdvParams);
    dqdv = improvedResult.dqdv;
    dqdvVoltage = improvedResult.voltage;
  } else {
    const useAnalyticalDqdv = dqdvParams.method === 'analytical' && 
      (fittingParams.method === 'spline' || fittingParams.method === 'bspline' || 
       fittingParams.method === 'gaussian' || fittingParams.method === 'polynomial');

    if (useAnalyticalDqdv) {
      switch (fittingParams.method) {
        case 'polynomial':
          dqdv = uniformVoltage.map(v => polynomialDerivative(polyCoeffsQ!, v));
          break;
        case 'spline':
          dqdv = uniformVoltage.map(v => splineQ!.derivative(v));
          break;
        case 'bspline':
          dqdv = uniformVoltage.map(v => bsplineQ!.derivative(v));
          break;
        case 'gaussian':
          dqdv = uniformVoltage.map(v => gpQ!.derivative(v));
          break;
        default:
          dqdv = computeNumericalDerivative(fittedCapacity, uniformVoltage, dqdvParams);
      }
    } else {
      dqdv = computeNumericalDerivative(fittedCapacity, uniformVoltage, dqdvParams);
    }
    
    // 应用 dQ/dV 的平滑
    dqdv = applySmoothing(dqdv, dqdvParams);
  }

  // 计算 dV/dQ（使用 dvdq 的参数）
  let dvdq: number[];
  let dvdqCapacity = uniformCapacity;
  const dvdqParams = diffParams.dvdq;
  
  // 如果使用改进方法，则调用改进的dV/dQ计算
  if (dvdqParams.method === 'improved') {
    const improvedResult = calculateImprovedDvdq(sortedVoltage, sortedCapacity, dvdqParams);
    dvdq = improvedResult.dvdq;
    dvdqCapacity = improvedResult.capacity;
  } else {
    const useAnalyticalDvdq = dvdqParams.method === 'analytical' && 
      (fittingParams.method === 'spline' || fittingParams.method === 'bspline' || 
       fittingParams.method === 'gaussian' || fittingParams.method === 'polynomial');

    if (useAnalyticalDvdq) {
      switch (fittingParams.method) {
        case 'polynomial':
          dvdq = uniformCapacity.map(c => polynomialDerivative(polyCoeffsV!, c));
          break;
        case 'spline':
          dvdq = uniformCapacity.map(c => splineV!.derivative(c));
          break;
        case 'bspline':
          dvdq = uniformCapacity.map(c => bsplineV!.derivative(c));
          break;
        case 'gaussian':
          dvdq = uniformCapacity.map(c => gpV!.derivative(c));
          break;
        default:
          dvdq = computeNumericalDerivative(fittedVoltage, uniformCapacity, dvdqParams);
      }
    } else {
      dvdq = computeNumericalDerivative(fittedVoltage, uniformCapacity, dvdqParams);
    }
    
    // 应用 dV/dQ 的平滑
    dvdq = applySmoothing(dvdq, dvdqParams);
  }

  // 计算 dSOC/dV（归一化的 dQ/dV）
  // Q_max 取容量的最大变化范围
  const maxCapacity = Math.max(...sortedCapacity) - Math.min(...sortedCapacity);
  // 防止除以零，如果 maxCapacity 为 0 或无效，使用 dqdv 的最大值作为归一化因子
  const dsocdvNormalizer = maxCapacity > 0 ? maxCapacity : (Math.max(...dqdv.map(Math.abs)) || 1);
  const dsocdv = dqdv.map(d => d / dsocdvNormalizer);

  // ==================== 新增曲线计算 ====================
  // 计算 SOC（归一化容量，范围 0-1）
  const minCapacity = Math.min(...sortedCapacity);
  
  // 确保所有数组使用同一个电压网格
  // 当使用改进方法时，dqdvVoltage 与 dqdv 长度相同，我们使用它作为统一的 x 轴
  const unifiedVoltageForDqdv = dqdvVoltage || uniformVoltage;
  
  // 创建样条插值器用于电压到容量的映射
  // 注意：必须使用单调的 x 轴
  // 当使用改进方法时，使用 dqdvVoltage 作为 x 轴
  // 否则使用 uniformVoltage
  const capacitySplineForDqdv = new CubicSpline(unifiedVoltageForDqdv, 
    unifiedVoltageForDqdv === uniformVoltage ? fittedCapacity : 
    (() => {
      // 对于改进方法，需要先创建从 unifiedVoltage 到 fittedCapacity 的映射
      const spline = new CubicSpline(uniformVoltage, fittedCapacity);
      return unifiedVoltageForDqdv.map(v => spline.evaluate(v));
    })()
  );
  
  // 对于 dQ/dV 曲线对应的 SOC（基于统一电压网格）
  const dqdvSocX = unifiedVoltageForDqdv.map(v => {
    const capacity = capacitySplineForDqdv.evaluate(v);
    return (capacity - minCapacity) / maxCapacity;
  });
  
  // 对于 dQ/dV 曲线对应的容量（基于统一电压网格）
  const dqdvCapacity = unifiedVoltageForDqdv.map(v => {
    return capacitySplineForDqdv.evaluate(v);
  });

  // V vs SOC 数据：使用统一的电压网格对应的电压和 SOC
  const dqdvVoltageForVSoc = unifiedVoltageForDqdv;

  // 确保所有数组长度一致（用于调试）
  console.log('calculateDifferential - dqdv length:', dqdv.length, 'dqdvVoltage length:', dqdvVoltage?.length, 'uniformVoltage length:', uniformVoltage.length);
  console.log('calculateDifferential - dsocdv length:', dsocdv.length, 'dqdvSocX length:', dqdvSocX.length, 'dqdvCapacity length:', dqdvCapacity.length);
  
  // 确保 dqdv, dsocdv, dqdvSocX, dqdvCapacity 长度一致
  const minDqdvLen = Math.min(dqdv.length, dsocdv.length, dqdvSocX.length, dqdvCapacity.length);
  const dqdvFinal = dqdv.slice(0, minDqdvLen);
  const dsocdvFinal = dsocdv.slice(0, minDqdvLen);
  const dqdvSocXFinal = dqdvSocX.slice(0, minDqdvLen);
  const dqdvCapacityFinal = dqdvCapacity.slice(0, minDqdvLen);
  
  // 创建样条插值器用于容量到电压的映射
  // 注意：必须使用单调的 x 轴
  // 当使用改进方法时，使用 dvdqCapacity 作为 x 轴
  const unifiedCapacityForDvdq = dvdqCapacity || uniformCapacity;
  const voltageSplineForDvdq = new CubicSpline(unifiedCapacityForDvdq,
    unifiedCapacityForDvdq === uniformCapacity ? fittedVoltage :
    (() => {
      const spline = new CubicSpline(uniformCapacity, fittedVoltage);
      return unifiedCapacityForDvdq.map(c => spline.evaluate(c));
    })()
  );
  
  // 对于 dV/dQ 曲线对应的电压
  const dvdqVoltageFinal = unifiedCapacityForDvdq.map(c => {
    return voltageSplineForDvdq.evaluate(c);
  });
  
  // 对于 dV/dQ 曲线对应的 SOC
  const dvdqSocXFinal = unifiedCapacityForDvdq.map(c => (c - minCapacity) / maxCapacity);

  // 确保所有数组长度一致
  const minDvdqLen = Math.min(dvdq.length, dvdqVoltageFinal.length, dvdqSocXFinal.length);
  const dvdqFinal = dvdq.slice(0, minDvdqLen);
  const dvdqVoltageForReturn = dvdqVoltageFinal.slice(0, minDvdqLen);
  const dvdqSocXForReturn = dvdqSocXFinal.slice(0, minDvdqLen);
  
  // 对于 dSOC/dV 曲线对应的容量和 SOC（使用截断后的 dqdv 数据）
  const dsocdvCapacityFinal = dqdvCapacityFinal;
  const dsocdvSocXFinal = dqdvSocXFinal;

  return {
    voltage: sortedVoltage,
    capacity: sortedCapacity,
    fittedVoltage,
    fittedCapacity,
    uniformVoltage,
    uniformCapacity,
    dqdv: dqdvFinal,
    dvdq: dvdqFinal,
    dsocdv: dsocdvFinal,
    maxCapacity,
    dqdvVoltage: dqdvVoltage || uniformVoltage,
    dvdqCapacity: dvdqCapacity || uniformCapacity,
    // 新增曲线数据（使用统一长度的数组）
    soc: dqdvSocXFinal, // SOC 数组
    // dQ/dV vs Q
    dqdvQ: dqdvFinal,
    dqdvCapacity: dqdvCapacityFinal,
    // dQ/dV vs SOC
    dqdvSoc: dqdvFinal,
    dqdvSocX: dqdvSocXFinal,
    // dV/dQ vs V
    dvdqV: dvdqFinal,
    dvdqVoltage: dvdqVoltageForReturn,
    // dV/dQ vs SOC
    dvdqSoc: dvdqFinal,
    dvdqSocX: dvdqSocXForReturn,
    // dSOC/dV vs Q
    dsocdvQ: dsocdvFinal,
    dsocdvCapacity: dsocdvCapacityFinal,
    // dSOC/dV vs SOC
    dsocdvSoc: dsocdvFinal,
    dsocdvSocX: dsocdvSocXFinal,
    // V vs SOC（基于 dQ/dV 曲线的电压网格）
    vSoc: dqdvVoltageForVSoc.slice(0, minDqdvLen),
    vSocX: dqdvSocXFinal,
  };
}

/**
 * 计算拟合优度 R²
 */
export function calculateR2(
  actual: number[],
  predicted: number[]
): number {
  const mean = actual.reduce((a, b) => a + b, 0) / actual.length;
  const ssTotal = actual.reduce((sum, y) => sum + Math.pow(y - mean, 2), 0);
  const ssRes = actual.reduce((sum, y, i) => sum + Math.pow(y - predicted[i], 2), 0);
  return 1 - ssRes / ssTotal;
}

/**
 * 验证数据有效性
 */
export function validateData(
  voltage: number[],
  capacity: number[]
): string | null {
  if (!Array.isArray(voltage) || !Array.isArray(capacity)) {
    return '数据必须是数组';
  }

  if (voltage.length === 0 || capacity.length === 0) {
    return '数据不能为空';
  }

  if (voltage.length !== capacity.length) {
    return `电压数据长度(${voltage.length})与容量数据长度(${capacity.length})不一致`;
  }

  for (let i = 0; i < voltage.length; i++) {
    if (typeof voltage[i] !== 'number' || isNaN(voltage[i])) {
      return `电压数据第${i + 1}个值无效`;
    }
    if (typeof capacity[i] !== 'number' || isNaN(capacity[i])) {
      return `容量数据第${i + 1}个值无效`;
    }
  }

  return null;
}

/**
 * 默认拟合参数
 */
export const defaultFittingParams: FittingParams = {
  method: 'spline',
  polynomialDegree: 5,
  bsplineDegree: 3,
  bsplineKnots: 15,
  loessSpan: 0.3,
  loessDegree: 2,
  gpLengthScale: 0.1,
  gpSigmaF: 1,
  gpSigmaN: 0.01,
  numPoints: 200,
};

/**
 * 默认差分参数
 */
export const defaultDifferentialParams = (): DifferentialParams => ({
  method: 'analytical',
  windowSize: 1,
  enableSmoothing: true,
  smoothingMethod: 'savitzky_golay',
  smoothingWindow: 7,
  smoothingSigma: 1,
  // 改进方法参数
  enablePreFilter: false,
  preFilterMethod: 'savitzky_golay',
  preFilterWindow: 5,
  preFilterSigma: 1,
  voltageInterpolationPoints: 500,
});

/**
 * 改进方法的默认参数（用于dV/dQ）
 */
export const improvedDifferentialParams = (): DifferentialParams => ({
  method: 'improved',
  windowSize: 1,
  enableSmoothing: true,
  smoothingMethod: 'savitzky_golay',
  smoothingWindow: 9,
  smoothingSigma: 1.5,
  // 改进方法参数
  enablePreFilter: true,
  preFilterMethod: 'savitzky_golay',
  preFilterWindow: 7,
  preFilterSigma: 1,
  voltageInterpolationPoints: 500,
});

/**
 * 默认分开差分参数
 */
export const defaultSeparateDiffParams = (): SeparateDiffParams => ({
  dqdv: defaultDifferentialParams(),
  dvdq: improvedDifferentialParams(), // dV/dQ默认使用改进方法
});

/**
 * 拟合结果（仅拟合，不含差分）
 */
export interface FittingResult {
  voltage: number[];
  capacity: number[];
  fittedVoltage: number[];  // 基于容量网格的拟合电压
  fittedCapacity: number[]; // 基于电压网格的拟合容量
  uniformVoltage: number[]; // 均匀电压网格
  uniformCapacity: number[]; // 均匀容量网格
}

/**
 * 执行曲线拟合（独立功能，不含差分计算）
 * 仅进行拟合操作，生成拟合曲线数据
 */
export function performFitting(
  voltage: number[],
  capacity: number[],
  fittingParams: FittingParams
): FittingResult {
  if (voltage.length !== capacity.length) {
    throw new Error('电压和容量数据长度不一致');
  }

  if (voltage.length < 5) {
    throw new Error('数据点太少，至少需要5个点');
  }

  // 按电压排序（用于 Q(V) 拟合）
  const { voltage: sortedVoltage, capacity: sortedCapacity } = sortAndUniqueData(
    voltage,
    capacity
  );

  // 按容量排序（用于 V(Q) 拟合）
  const { voltage: sortedVoltageByC, capacity: sortedCapacityByC } = sortAndUniqueDataByCapacity(
    voltage,
    capacity
  );

  // 创建均匀网格
  const vMin = Math.min(...sortedVoltage);
  const vMax = Math.max(...sortedVoltage);
  const cMin = Math.min(...sortedCapacityByC);
  const cMax = Math.max(...sortedCapacityByC);

  const uniformVoltage = createUniformGrid(vMin, vMax, fittingParams.numPoints);
  const uniformCapacity = createUniformGrid(cMin, cMax, fittingParams.numPoints);

  // 拟合
  let fittedCapacity: number[];
  let fittedVoltage: number[];
  
  switch (fittingParams.method) {
    case 'polynomial': {
      // 多项式拟合不要求 x 单调
      const polyCoeffsQ = polynomialFit(sortedVoltage, sortedCapacity, fittingParams.polynomialDegree);
      const polyCoeffsV = polynomialFit(sortedCapacityByC, sortedVoltageByC, fittingParams.polynomialDegree);
      fittedCapacity = uniformVoltage.map(v => polynomialEvaluate(polyCoeffsQ, v));
      fittedVoltage = uniformCapacity.map(c => polynomialEvaluate(polyCoeffsV, c));
      break;
    }

    case 'spline': {
      // 样条拟合要求 x 单调
      const splineQ = new CubicSpline(sortedVoltage, sortedCapacity);       // Q(V): x=电压(单调)
      const splineV = new CubicSpline(sortedCapacityByC, sortedVoltageByC); // V(Q): x=容量(单调)
      fittedCapacity = uniformVoltage.map(v => splineQ.evaluate(v));
      fittedVoltage = uniformCapacity.map(c => splineV.evaluate(c));
      break;
    }

    case 'bspline': {
      // B样条拟合
      const bsplineQ = new BSpline(sortedVoltage, sortedCapacity, fittingParams.bsplineDegree, fittingParams.bsplineKnots);
      const bsplineV = new BSpline(sortedCapacityByC, sortedVoltageByC, fittingParams.bsplineDegree, fittingParams.bsplineKnots);
      fittedCapacity = uniformVoltage.map(v => bsplineQ.evaluate(v));
      fittedVoltage = uniformCapacity.map(c => bsplineV.evaluate(c));
      break;
    }

    case 'loess': {
      // LOESS 拟合
      fittedCapacity = loessFit(sortedVoltage, sortedCapacity, uniformVoltage, fittingParams.loessSpan, fittingParams.loessDegree);
      fittedVoltage = loessFit(sortedCapacityByC, sortedVoltageByC, uniformCapacity, fittingParams.loessSpan, fittingParams.loessDegree);
      break;
    }

    case 'gaussian': {
      // 高斯过程拟合
      const gpQ = new GaussianProcess(sortedVoltage, sortedCapacity, fittingParams.gpLengthScale, fittingParams.gpSigmaF, fittingParams.gpSigmaN);
      const gpV = new GaussianProcess(sortedCapacityByC, sortedVoltageByC, fittingParams.gpLengthScale, fittingParams.gpSigmaF, fittingParams.gpSigmaN);
      fittedCapacity = uniformVoltage.map(v => gpQ.evaluate(v));
      fittedVoltage = uniformCapacity.map(c => gpV.evaluate(c));
      break;
    }

    default:
      throw new Error(`未知的拟合方法: ${fittingParams.method}`);
  }

  return {
    voltage: sortedVoltage,
    capacity: sortedCapacity,
    fittedVoltage,
    fittedCapacity,
    uniformVoltage,
    uniformCapacity,
  };
}

/**
 * 计算恒压充电模式下的 dQ/dI（差分电流分析）
 * 基于论文: Ko et al. (2024) - Differential current in constant-voltage charging mode
 * 
 * 原理:
 * - 在恒压充电模式下，电压保持恒定，电流随时间衰减
 * - 容量 Q = ∫I dt
 * - dQ/dI = I / (dI/dt) 表示容量对电流的变化率
 * - dQ/dI 与电池的特征时间常数 τ 相关，可用于 SOH 和 SOC 估计
 * 
 * @param current - 电流数组 (A)
 * @param time - 时间数组 (s)，可选。如果不提供，则使用索引作为时间
 * @param params - 差分参数
 * @param fittingParams - 拟合参数
 * @returns DqdiResult 包含 dQ/dI 分析结果
 */
export function calculateDqdi(
  current: number[],
  time?: number[],
  params: DifferentialParams = defaultSeparateDiffParams().dqdv,
  fittingParams: FittingParams = defaultFittingParams
): DqdiResult {
  if (current.length < 5) {
    throw new Error('数据点太少，至少需要5个点');
  }

  // 如果没有提供时间数组，使用索引作为时间（假设采样间隔为1秒）
  const timeArray = time || current.map((_, i) => i);
  
  // 确保数据长度一致
  const n = Math.min(current.length, timeArray.length);
  const curr = current.slice(0, n);
  const t = timeArray.slice(0, n);

  // 按时间排序
  const indices = t.map((_, i) => i);
  indices.sort((a, b) => t[a] - t[b]);
  
  const sortedCurrent: number[] = [];
  const sortedTime: number[] = [];
  
  for (const i of indices) {
    sortedCurrent.push(curr[i]);
    sortedTime.push(t[i]);
  }

  // 计算容量：Q = ∫I dt (单位转换：A*s -> Ah，除以3600)
  const capacity: number[] = [];
  let Q = 0;
  capacity.push(0);
  
  for (let i = 1; i < sortedCurrent.length; i++) {
    // 梯形积分
    const dt = sortedTime[i] - sortedTime[i - 1];
    const avgI = (sortedCurrent[i] + sortedCurrent[i - 1]) / 2;
    Q += avgI * dt / 3600; // 转换为 Ah
    capacity.push(Q);
  }

  const maxCurrent = Math.max(...sortedCurrent);
  const totalCapacity = capacity[capacity.length - 1];

  // 创建均匀电流网格（电流从高到低）
  const iMin = Math.min(...sortedCurrent);
  const iMax = Math.max(...sortedCurrent);
  const uniformCurrent = createUniformGrid(iMin, iMax, fittingParams.numPoints);

  // 使用样条拟合 I-Q 曲线
  // 注意：需要按电流排序（电流是单调递减的）
  const sortedByCurrent = sortedCurrent.map((c, i) => ({ c, q: capacity[i] }));
  sortedByCurrent.sort((a, b) => a.c - b.c); // 按电流升序排列
  
  const currentForFit = sortedByCurrent.map(d => d.c);
  const capacityForFit = sortedByCurrent.map(d => d.q);

  // 样条拟合 Q(I)
  const splineQI = new CubicSpline(currentForFit, capacityForFit);
  const fittedCapacity = uniformCurrent.map(i => splineQI.evaluate(i));

  // 计算 dQ/dI（解析导数）
  let dqdi: number[];
  
  if (params.method === 'analytical') {
    // 使用样条导数
    dqdi = uniformCurrent.map(i => splineQI.derivative(i));
  } else {
    // 数值差分
    dqdi = computeNumericalDerivative(fittedCapacity, uniformCurrent, params);
  }

  // 应用平滑
  if (params.enableSmoothing) {
    dqdi = applySmoothing(dqdi, params);
  }

  // 计算 dI/dQ
  const didq = dqdi.map(d => d !== 0 ? 1 / d : 0);

  return {
    current: sortedCurrent,
    capacity,
    time: sortedTime,
    dqdi,
    fittedCurrent: uniformCurrent,
    fittedCapacity,
    uniformCurrent,
    // dQ/dI vs I 曲线
    dqdiCurrent: uniformCurrent,
    dqdiValue: dqdi,
    // dI/dQ vs Q 曲线
    didqCapacity: fittedCapacity,
    didqValue: didq,
    maxCurrent,
    totalCapacity,
  };
}

/**
 * 稳健的dQ/dI计算方法（新算法）
 * 先对I-Q曲线进行拟合，然后对拟合曲线进行微分处理
 * 
 * @param current - 电流数组 (A)
 * @param capacity - 容量数组 (Ah)
 * @param params - 差分参数
 * @param fittingParams - 拟合参数
 * @returns DqdiResult 包含 dQ/dI 分析结果
 */
export function calculateDqdiRobust(
  current: number[],
  capacity: number[],
  params: DifferentialParams = defaultDqdiParams(),
  fittingParams: FittingParams = defaultFittingParams
): DqdiResult {
  if (current.length < 5) {
    throw new Error('数据点太少，至少需要5个点');
  }

  if (current.length !== capacity.length) {
    throw new Error('电流和容量数组长度不一致');
  }

  console.log('开始稳健dQ/dI计算，数据点数:', current.length);

  // 1. 数据预处理：按电流排序并去重
  const data = current.map((c, i) => ({ c, q: capacity[i] }));
  data.sort((a, b) => a.c - b.c);
  
  const sortedCurrent = data.map(d => d.c);
  const sortedCapacity = data.map(d => d.q);

  // 移除重复的电流值
  const uniqueData: { c: number; q: number }[] = [];
  for (let i = 0; i < sortedCurrent.length; i++) {
    if (i === 0 || Math.abs(sortedCurrent[i] - sortedCurrent[i - 1]) > 1e-6) {
      uniqueData.push({ c: sortedCurrent[i], q: sortedCapacity[i] });
    }
  }

  if (uniqueData.length < 5) {
    throw new Error('去重后数据点太少，至少需要5个点');
  }

  const uniqueCurrent = uniqueData.map(d => d.c);
  const uniqueCapacity = uniqueData.map(d => d.q);

  console.log('去重后数据点数:', uniqueData.length);
  console.log('电流范围:', Math.min(...uniqueCurrent).toFixed(2), '至', Math.max(...uniqueCurrent).toFixed(2));
  console.log('容量范围:', Math.min(...uniqueCapacity).toFixed(2), '至', Math.max(...uniqueCapacity).toFixed(2));

  const maxCurrent = Math.max(...uniqueCurrent);
  const minCurrent = Math.min(...uniqueCurrent);
  const totalCapacity = Math.max(...uniqueCapacity);

  // 2. 创建均匀电流网格（用于计算）
  const uniformCurrent = createUniformGrid(minCurrent, maxCurrent, fittingParams.numPoints);
  console.log('均匀网格点数:', uniformCurrent.length);

  // 3. 对I-Q曲线进行拟合
  let fittedCapacity: number[];
  let fittingMethod: string;

  // 优先使用多项式拟合（更稳健）
  try {
    const polyDegree = Math.min(fittingParams.polynomialDegree, uniqueData.length - 2);
    console.log(`尝试多项式拟合（次数=${polyDegree}）`);
    const polyCoeffs = polynomialFit(uniqueCurrent, uniqueCapacity, polyDegree);
    fittedCapacity = uniformCurrent.map(i => polynomialEvaluate(polyCoeffs, i));
    fittingMethod = `polynomial_degree_${polyDegree}`;
    console.log('多项式拟合成功');
  } catch (e) {
    // 多项式拟合失败，使用样条拟合
    console.warn('多项式拟合失败，使用样条拟合:', e);
    const splineQI = new CubicSpline(uniqueCurrent, uniqueCapacity);
    fittedCapacity = uniformCurrent.map(i => splineQI.evaluate(i));
    fittingMethod = 'cubic_spline';
    console.log('样条拟合成功');
  }

  console.log('拟合完成，容量范围:', Math.min(...fittedCapacity).toFixed(2), '至', Math.max(...fittedCapacity).toFixed(2));

  // 4. 计算dQ/dI
  let dqdi: number[];

  if (params.method === 'analytical') {
    // 使用中心差分计算数值导数（更稳健）
    dqdi = numericalDerivativeCenterRobust(fittedCapacity, uniformCurrent);
    console.log('使用中心差分法计算导数');
  } else {
    // 根据窗口大小使用不同的差分方法
    dqdi = computeNumericalDerivative(fittedCapacity, uniformCurrent, params);
    console.log(`使用差分窗口=${params.windowSize}计算导数`);
  }

  console.log('dQ/dI计算完成，范围:', Math.min(...dqdi).toFixed(4), '至', Math.max(...dqdi).toFixed(4));

  // 5. 应用平滑处理
  if (params.enableSmoothing) {
    console.log('应用平滑，方法:', params.smoothingMethod, '窗口:', params.smoothingWindow);
    dqdi = applySmoothing(dqdi, params);
    console.log('平滑后dQ/dI范围:', Math.min(...dqdi).toFixed(4), '至', Math.max(...dqdi).toFixed(4));
  }

  // 6. 计算dI/dQ（注意：dI/dQ = 1/(dQ/dI)）
  const didq = dqdi.map((d, i) => {
    // 处理奇异点：当dQ/dI接近0时，dI/dQ会非常大
    if (Math.abs(d) < 1e-8) {
      // 使用相邻值的插值
      let left = 0, right = 0, count = 0;
      if (i > 0 && Math.abs(dqdi[i-1]) > 1e-8) {
        left = 1 / dqdi[i-1];
        count++;
      }
      if (i < dqdi.length - 1 && Math.abs(dqdi[i+1]) > 1e-8) {
        right = 1 / dqdi[i+1];
        count++;
      }
      return count > 0 ? (left + right) / count : 0;
    }
    return 1 / d;
  });

  console.log('dI/dQ计算完成，范围:', Math.min(...didq).toFixed(4), '至', Math.max(...didq).toFixed(4));

  // 7. 创建时间数组（用于兼容返回类型）
  const time = uniqueCurrent.map((_, i) => i);

  return {
    current: uniqueCurrent,
    capacity: uniqueCapacity,
    time,
    dqdi,
    fittedCurrent: uniformCurrent,
    fittedCapacity,
    uniformCurrent,
    // dQ/dI vs I 曲线
    dqdiCurrent: uniformCurrent,
    dqdiValue: dqdi,
    // dI/dQ vs Q 曲线
    didqCapacity: fittedCapacity,
    didqValue: didq,
    maxCurrent,
    totalCapacity,
  };
}

/**
 * 直接差分参数
 */
export interface DirectDiffParams {
  // dQ/dV 直接差分参数
  dqdv: {
    method: 'center' | 'forward' | 'backward' | 'savitzky_golay';
    windowSize: number; // 用于 SG 和移动平均的窗口大小
    enableSmoothing: boolean;
    smoothingMethod: 'moving_average' | 'savitzky_golay' | 'gaussian';
    smoothingWindow: number;
    smoothingSigma: number;
  };
  // dV/dQ 直接差分参数
  dvdq: {
    method: 'center' | 'forward' | 'backward' | 'savitzky_golay';
    windowSize: number;
    enableSmoothing: boolean;
    smoothingMethod: 'moving_average' | 'savitzky_golay' | 'gaussian';
    smoothingWindow: number;
    smoothingSigma: number;
  };
}

/**
 * 差分曲线拟合参数
 */
export interface DiffCurveFittingParams {
  // 是否启用差分曲线拟合
  enabled: boolean;
  // 拟合方法
  method: 'polynomial' | 'spline' | 'bspline' | 'loess';
  // 多项式阶数
  polynomialDegree: number;
  // B样条阶数
  bsplineDegree: number;
  bsplineKnots: number;
  // LOESS 参数
  loessSpan: number;
  loessDegree: number;
  // 拟合输出点数
  numPoints: number;
  // 拟合后是否再平滑
  enablePostSmoothing: boolean;
  postSmoothingMethod: 'moving_average' | 'savitzky_golay' | 'gaussian';
  postSmoothingWindow: number;
}

/**
 * 直接差分结果
 */
export interface DirectDiffResult {
  // 原始数据差分结果
  rawDqdv: { voltage: number[]; dqdv: number[] };
  rawDvdq: { capacity: number[]; dvdq: number[] };
  // 差分曲线拟合结果
  fittedDqdv: { voltage: number[]; dqdv: number[]; dqdvSmoothed: number[] };
  fittedDvdq: { capacity: number[]; dvdq: number[]; dvdqSmoothed: number[] };
  // dSOC/dV（归一化的dQ/dV）
  dsocdv: number[];
  maxCapacity: number;
  // 新增曲线数据
  // dQ/dV vs Q
  dqdvQ: number[];       // dQ/dV 值
  dqdvCapacity: number[]; // 对应的容量点
  // dQ/dV vs SOC
  dqdvSoc: number[];     // dQ/dV 值
  dqdvSocX: number[];    // 对应的SOC点
  // dV/dQ vs V
  dvdqV: number[];       // dV/dQ 值
  dvdqVoltage: number[]; // 对应的电压点
  // dV/dQ vs SOC
  dvdqSoc: number[];     // dV/dQ 值
  dvdqSocX: number[];    // 对应的SOC点
  // dSOC/dV vs Q
  dsocdvQ: number[];       // dSOC/dV 值
  dsocdvCapacity: number[]; // 对应的容量点
  // dSOC/dV vs SOC
  dsocdvSoc: number[];     // dSOC/dV 值
  dsocdvSocX: number[];    // 对应的SOC点
  // V vs SOC
  vSoc: number[];          // 电压值
  vSocX: number[];         // 对应的SOC点
}

/**
 * 默认直接差分参数
 */
export function defaultDirectDiffParams(): DirectDiffParams {
  return {
    dqdv: {
      method: 'savitzky_golay',
      windowSize: 5,
      enableSmoothing: true,
      smoothingMethod: 'savitzky_golay',
      smoothingWindow: 7,
      smoothingSigma: 1.5,
    },
    dvdq: {
      method: 'savitzky_golay',
      windowSize: 5,
      enableSmoothing: true,
      smoothingMethod: 'savitzky_golay',
      smoothingWindow: 7,
      smoothingSigma: 1.5,
    },
  };
}

/**
 * 默认差分曲线拟合参数
 */
export function defaultDiffCurveFittingParams(): DiffCurveFittingParams {
  return {
    enabled: true,
    method: 'spline',
    polynomialDegree: 5,
    bsplineDegree: 3,
    bsplineKnots: 15,
    loessSpan: 0.3,
    loessDegree: 2,
    numPoints: 200,
    enablePostSmoothing: true,
    postSmoothingMethod: 'savitzky_golay',
    postSmoothingWindow: 5,
  };
}

/**
 * 直接对原始数据进行数值差分（不经过拟合）
 * @param x 原始 x 数据（电压或容量）
 * @param y 原始 y 数据（容量或电压）
 * @param params 差分参数
 * @returns 差分结果
 */
function computeDirectDerivative(
  x: number[],
  y: number[],
  params: DirectDiffParams['dqdv']
): { x: number[]; derivative: number[] } {
  const n = x.length;
  const derivative: number[] = [];
  const resultX: number[] = [];

  switch (params.method) {
    case 'center': {
      // 中心差分
      for (let i = 1; i < n - 1; i++) {
        const dx = x[i + 1] - x[i - 1];
        const dy = y[i + 1] - y[i - 1];
        derivative.push(dx !== 0 ? dy / dx : 0);
        resultX.push(x[i]);
      }
      break;
    }

    case 'forward': {
      // 前向差分
      for (let i = 0; i < n - 1; i++) {
        const dx = x[i + 1] - x[i];
        const dy = y[i + 1] - y[i];
        derivative.push(dx !== 0 ? dy / dx : 0);
        resultX.push(x[i]);
      }
      break;
    }

    case 'backward': {
      // 后向差分
      for (let i = 1; i < n; i++) {
        const dx = x[i] - x[i - 1];
        const dy = y[i] - y[i - 1];
        derivative.push(dx !== 0 ? dy / dx : 0);
        resultX.push(x[i]);
      }
      break;
    }

    case 'savitzky_golay': {
      // Savitzky-Golay 微分（直接计算导数）
      const windowSize = params.windowSize;
      const halfWindow = Math.floor(windowSize / 2);
      
      for (let i = halfWindow; i < n - halfWindow; i++) {
        // 提取窗口内的数据
        const windowX: number[] = [];
        const windowY: number[] = [];
        for (let j = i - halfWindow; j <= i + halfWindow; j++) {
          windowX.push(x[j] - x[i]); // 归一化到中心
          windowY.push(y[j]);
        }
        
        // 简单线性回归计算斜率作为导数近似
        const n_points = windowX.length;
        const sumX = windowX.reduce((a, b) => a + b, 0);
        const sumY = windowY.reduce((a, b) => a + b, 0);
        const sumXY = windowX.reduce((sum, xi, idx) => sum + xi * windowY[idx], 0);
        const sumX2 = windowX.reduce((sum, xi) => sum + xi * xi, 0);
        
        const slope = n_points * sumXY - sumX * sumY;
        const denom = n_points * sumX2 - sumX * sumX;
        
        derivative.push(denom !== 0 ? slope / denom : 0);
        resultX.push(x[i]);
      }
      break;
    }
  }

  // 应用平滑
  let result = derivative;
  if (params.enableSmoothing) {
    result = applyDirectSmoothing(result, params);
  }

  return { x: resultX, derivative: result };
}

/**
 * 应用平滑到差分结果
 */
function applyDirectSmoothing(
  data: number[],
  params: DirectDiffParams['dqdv']
): number[] {
  const { smoothingMethod, smoothingWindow, smoothingSigma } = params;
  
  switch (smoothingMethod) {
    case 'moving_average': {
      const result: number[] = [];
      const halfWindow = Math.floor(smoothingWindow / 2);
      for (let i = 0; i < data.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - halfWindow); j <= Math.min(data.length - 1, i + halfWindow); j++) {
          sum += data[j];
          count++;
        }
        result.push(count > 0 ? sum / count : 0);
      }
      return result;
    }

    case 'savitzky_golay': {
      // Savitzky-Golay 平滑
      return savitzkyGolaySmooth(data, smoothingWindow);
    }

    case 'gaussian': {
      const result: number[] = [];
      const halfWindow = Math.floor(smoothingWindow / 2);
      for (let i = 0; i < data.length; i++) {
        let sum = 0;
        let weightSum = 0;
        for (let j = Math.max(0, i - halfWindow); j <= Math.min(data.length - 1, i + halfWindow); j++) {
          const dist = i - j;
          const weight = Math.exp(-(dist * dist) / (2 * smoothingSigma * smoothingSigma));
          sum += data[j] * weight;
          weightSum += weight;
        }
        result.push(weightSum > 0 ? sum / weightSum : 0);
      }
      return result;
    }

    default:
      return data;
  }
}

/**
 * 对差分曲线进行拟合
 */
function fitDifferentialCurve(
  x: number[],
  y: number[],
  params: DiffCurveFittingParams
): { x: number[]; y: number[] } {
  if (!params.enabled || x.length < 3) {
    return { x, y };
  }

  const numPoints = Math.min(params.numPoints, x.length);
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);
  const uniformX: number[] = [];
  for (let i = 0; i < numPoints; i++) {
    uniformX.push(xMin + (xMax - xMin) * i / (numPoints - 1));
  }

  let fittedY: number[];

  switch (params.method) {
    case 'polynomial': {
      const coeffs = polynomialFit(x, y, params.polynomialDegree);
      fittedY = uniformX.map(v => polynomialEvaluate(coeffs, v));
      break;
    }

    case 'spline': {
      const spline = new CubicSpline(x, y);
      fittedY = uniformX.map(v => spline.evaluate(v));
      break;
    }

    case 'bspline': {
      const bspline = new BSpline(x, y, params.bsplineDegree, params.bsplineKnots);
      fittedY = uniformX.map(v => bspline.evaluate(v));
      break;
    }

    case 'loess': {
      fittedY = loessFit(x, y, uniformX, params.loessSpan, params.loessDegree);
      break;
    }

    default:
      fittedY = y.slice(0, numPoints);
  }

  // 拟合后再平滑
  let result = fittedY;
  if (params.enablePostSmoothing) {
    result = applyPostSmoothing(fittedY, params);
  }

  return { x: uniformX, y: result };
}

/**
 * 拟合后平滑
 */
function applyPostSmoothing(
  data: number[],
  params: DiffCurveFittingParams
): number[] {
  const { postSmoothingMethod, postSmoothingWindow } = params;
  const window = Math.min(postSmoothingWindow, data.length);
  
  switch (postSmoothingMethod) {
    case 'moving_average': {
      const result: number[] = [];
      const halfWindow = Math.floor(window / 2);
      for (let i = 0; i < data.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - halfWindow); j <= Math.min(data.length - 1, i + halfWindow); j++) {
          sum += data[j];
          count++;
        }
        result.push(count > 0 ? sum / count : 0);
      }
      return result;
    }

    case 'savitzky_golay': {
      return savitzkyGolaySmooth(data, window);
    }

    case 'gaussian': {
      const result: number[] = [];
      const sigma = window / 6;
      const halfWindow = Math.floor(window / 2);
      for (let i = 0; i < data.length; i++) {
        let sum = 0;
        let weightSum = 0;
        for (let j = Math.max(0, i - halfWindow); j <= Math.min(data.length - 1, i + halfWindow); j++) {
          const dist = i - j;
          const weight = Math.exp(-(dist * dist) / (2 * sigma * sigma));
          sum += data[j] * weight;
          weightSum += weight;
        }
        result.push(weightSum > 0 ? sum / weightSum : 0);
      }
      return result;
    }

    default:
      return data;
  }
}

/**
 * 执行直接差分计算（不对原始数据拟合，直接差分后拟合差分曲线）
 */
export function calculateDirectDifferential(
  voltage: number[],
  capacity: number[],
  directDiffParams: DirectDiffParams,
  fittingParams: DiffCurveFittingParams
): DirectDiffResult {
  if (voltage.length !== capacity.length) {
    throw new Error('电压和容量数据长度不一致');
  }

  if (voltage.length < 3) {
    throw new Error('数据点太少，至少需要3个点');
  }

  // 按电压排序
  const sortedData = sortAndUniqueData(voltage, capacity);
  const { voltage: sortedVoltage, capacity: sortedCapacity } = sortedData;

  // 按容量排序
  const sortedByCapacity = sortAndUniqueDataByCapacity(voltage, capacity);
  const { voltage: sortedVoltageByC, capacity: sortedCapacityByC } = sortedByCapacity;

  // 计算 dQ/dV（按电压排序）
  const dqdvResult = computeDirectDerivative(sortedVoltage, sortedCapacity, directDiffParams.dqdv);
  const rawDqdv = { voltage: dqdvResult.x, dqdv: dqdvResult.derivative };

  // 计算 dV/dQ（按容量排序）
  const dvdqResult = computeDirectDerivative(sortedCapacityByC, sortedVoltageByC, directDiffParams.dvdq);
  const rawDvdq = { capacity: dvdqResult.x, dvdq: dvdqResult.derivative };

  // 对差分曲线进行拟合
  const fittedDqdv = fitDifferentialCurve(rawDqdv.voltage, rawDqdv.dqdv, fittingParams);
  const fittedDvdq = fitDifferentialCurve(rawDvdq.capacity, rawDvdq.dvdq, fittingParams);

  // 计算 SOC 相关数据
  const minCapacity = Math.min(...sortedCapacity);
  const maxCapacity = Math.max(...sortedCapacity) - minCapacity;

  // 创建样条插值器用于电压到容量的映射
  // 使用原始数据创建样条（需要先插值到统一网格）
  const numPoints = Math.min(fittingParams.numPoints, rawDqdv.voltage.length);
  const uniformVoltage = createUniformGrid(
    Math.min(...rawDqdv.voltage),
    Math.max(...rawDqdv.voltage),
    numPoints
  );
  
  // 对原始数据进行样条插值到统一网格
  const splineQV = new CubicSpline(rawDqdv.voltage, rawDqdv.dqdv);
  const splineCV = new CubicSpline(sortedVoltage, sortedCapacity);
  
  // 拟合后的dQ/dV对应统一电压网格
  const fittedDqdvVoltage = uniformVoltage;
  const fittedDqdvValues = uniformVoltage.map(v => splineQV.evaluate(v));
  const fittedDqdvCapacity = uniformVoltage.map(v => splineCV.evaluate(v));
  
  // 计算 SOC（归一化容量，范围 0-1）
  const dqdvSocX = fittedDqdvCapacity.map(c => (c - minCapacity) / maxCapacity);

  // 创建样条插值器用于容量到电压的映射
  const uniformCapacity = createUniformGrid(
    Math.min(...rawDvdq.capacity),
    Math.max(...rawDvdq.capacity),
    numPoints
  );
  
  const splineVQ = new CubicSpline(rawDvdq.capacity, rawDvdq.dvdq);
  const splineVC = new CubicSpline(sortedCapacityByC, sortedVoltageByC);
  
  // 拟合后的dV/dQ对应统一容量网格
  const fittedDvdqCapacityGrid = uniformCapacity;
  const fittedDvdqValues = uniformCapacity.map(c => splineVQ.evaluate(c));
  const fittedDvdqVoltage = uniformCapacity.map(c => splineVC.evaluate(c));
  
  // 计算 dV/dQ 对应的 SOC
  const dvdqSocX = uniformCapacity.map(c => (c - minCapacity) / maxCapacity);

  // 计算 dSOC/dV（归一化的 dQ/dV）
  const dsocdv = fittedDqdvValues.map(d => d / maxCapacity);
  
  // dSOC/dV vs SOC 使用与 dQ/dV vs SOC 相同的 SOC 值
  const dsocdvSocX = dqdvSocX;

  return {
    rawDqdv,
    rawDvdq,
    fittedDqdv: {
      voltage: fittedDqdvVoltage,
      dqdv: fittedDqdvValues,
      dqdvSmoothed: fittedDqdvValues,
    },
    fittedDvdq: {
      capacity: fittedDvdqCapacityGrid,
      dvdq: fittedDvdqValues,
      dvdqSmoothed: fittedDvdqValues,
    },
    // dSOC/dV
    dsocdv,
    maxCapacity,
    // dQ/dV vs Q
    dqdvQ: fittedDqdvValues,
    dqdvCapacity: fittedDqdvCapacity,
    // dQ/dV vs SOC
    dqdvSoc: fittedDqdvValues,
    dqdvSocX,
    // dV/dQ vs V
    dvdqV: fittedDvdqValues,
    dvdqVoltage: fittedDvdqVoltage,
    // dV/dQ vs SOC
    dvdqSoc: fittedDvdqValues,
    dvdqSocX,
    // dSOC/dV vs Q
    dsocdvQ: dsocdv,
    dsocdvCapacity: fittedDqdvCapacity,
    // dSOC/dV vs SOC
    dsocdvSoc: dsocdv,
    dsocdvSocX,
    // V vs SOC
    vSoc: uniformVoltage,
    vSocX: dqdvSocX,
  };
}

/**
 * 数值差分 - 中心差分（稳健版本）
 */
function numericalDerivativeCenterRobust(y: number[], x: number[]): number[] {
  const n = y.length;
  const result: number[] = [];
  
  if (n < 2) return result;
  
  // 使用更大的窗口进行中心差分，提高稳定性
  const window = Math.min(5, Math.floor(n / 2));
  
  // 边界：使用前向差分
  for (let i = 0; i < window; i++) {
    const dy = y[Math.min(n-1, i + window)] - y[i];
    const dx = x[Math.min(n-1, i + window)] - x[i];
    result.push(dy / dx);
  }
  
  // 中心区域：使用中心差分
  for (let i = window; i < n - window; i++) {
    const dy = y[i + window] - y[i - window];
    const dx = x[i + window] - x[i - window];
    result.push(dy / dx);
  }
  
  // 边界：使用后向差分
  for (let i = n - window; i < n; i++) {
    const dy = y[i] - y[Math.max(0, i - window)];
    const dx = x[i] - x[Math.max(0, i - window)];
    result.push(dy / dx);
  }
  
  return result;
}

/**
 * 默认的 dQ/dI 参数
 */
export function defaultDqdiParams(): DifferentialParams {
  return {
    method: 'analytical',
    windowSize: 1,
    enableSmoothing: true,
    smoothingMethod: 'savitzky_golay',
    smoothingWindow: 5,
    smoothingSigma: 1,
    // I-Q曲线拟合参数
    fittingMethod: 'polynomial',
    fittingDegree: 5,
    showFittedCurve: true,
  };
}

/**
 * 基于电流和容量数据计算 dQ/dI（适用于恒压充电阶段）
 * 改进的算法：直接使用电流-容量数据对，不需要时间信息
 * 
 * @param current - 电流数组 (A)
 * @param capacity - 容量数组 (Ah)
 * @param params - 差分参数
 * @param fittingParams - 拟合参数
 * @returns DqdiResult 包含 dQ/dI 分析结果
 */
export function calculateDqdiFromCurrentCapacity(
  current: number[],
  capacity: number[],
  params: DifferentialParams = defaultDqdiParams(),
  fittingParams: FittingParams = defaultFittingParams
): DqdiResult {
  if (current.length < 5) {
    throw new Error('数据点太少，至少需要5个点');
  }

  if (current.length !== capacity.length) {
    throw new Error('电流和容量数组长度不一致');
  }

  // 按电流排序（电流通常是单调递减的）
  const data = current.map((c, i) => ({ c, q: capacity[i] }));
  data.sort((a, b) => a.c - b.c); // 按电流升序排列
  
  const sortedCurrent = data.map(d => d.c);
  const sortedCapacity = data.map(d => d.q);

  // 移除重复的电流值（保持单调性）
  const uniqueData: { c: number; q: number }[] = [];
  for (let i = 0; i < sortedCurrent.length; i++) {
    if (i === 0 || Math.abs(sortedCurrent[i] - sortedCurrent[i - 1]) > 1e-6) {
      uniqueData.push({ c: sortedCurrent[i], q: sortedCapacity[i] });
    }
  }

  if (uniqueData.length < 5) {
    throw new Error('去重后数据点太少，至少需要5个点');
  }

  const uniqueCurrent = uniqueData.map(d => d.c);
  const uniqueCapacity = uniqueData.map(d => d.q);

  const maxCurrent = Math.max(...uniqueCurrent);
  const minCurrent = Math.min(...uniqueCurrent);
  const totalCapacity = Math.max(...uniqueCapacity);

  // 创建均匀电流网格
  const uniformCurrent = createUniformGrid(minCurrent, maxCurrent, fittingParams.numPoints);

  // 使用样条拟合 Q(I)
  const splineQI = new CubicSpline(uniqueCurrent, uniqueCapacity);
  const fittedCapacity = uniformCurrent.map(i => splineQI.evaluate(i));

  // 计算 dQ/dI（解析导数）
  let dqdi: number[];
  
  if (params.method === 'analytical') {
    // 使用样条导数
    dqdi = uniformCurrent.map(i => splineQI.derivative(i));
  } else {
    // 数值差分
    dqdi = computeNumericalDerivative(fittedCapacity, uniformCurrent, params);
  }

  // 应用平滑
  if (params.enableSmoothing) {
    dqdi = applySmoothing(dqdi, params);
  }

  // 计算 dI/dQ
  const didq = dqdi.map(d => Math.abs(d) > 1e-10 ? 1 / d : 0);

  // 创建时间数组（用于兼容返回类型）
  const time = uniqueCurrent.map((_, i) => i);

  return {
    current: uniqueCurrent,
    capacity: uniqueCapacity,
    time,
    dqdi,
    fittedCurrent: uniformCurrent,
    fittedCapacity,
    uniformCurrent,
    // dQ/dI vs I 曲线
    dqdiCurrent: uniformCurrent,
    dqdiValue: dqdi,
    // dI/dQ vs Q 曲线
    didqCapacity: fittedCapacity,
    didqValue: didq,
    maxCurrent,
    totalCapacity,
  };
}
