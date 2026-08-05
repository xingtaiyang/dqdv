/**
 * 数据平滑处理工具函数
 * 使用 Savitzky-Golay 滤波器进行专业的信号处理
 */

/**
 * 生成 Savitzky-Golay 滤波器系数
 * @param windowSize 窗口大小（必须是奇数）
 * @param polynomialOrder 多项式阶数
 * @param derivativeOrder 导数阶数（0=平滑，1=一阶导，2=二阶导）
 */
function computeSGCoefficients(
  windowSize: number,
  polynomialOrder: number,
  derivativeOrder: number = 0
): number[] {
  // 计算卷积核
  const halfWindow = Math.floor(windowSize / 2);
  const coefficients: number[] = [];

  // 构建范德蒙矩阵
  const A: number[][] = [];
  for (let i = -halfWindow; i <= halfWindow; i++) {
    const row: number[] = [];
    for (let j = 0; j <= polynomialOrder; j++) {
      row.push(Math.pow(i, j));
    }
    A.push(row);
  }

  // 计算 (A^T * A)^-1 * A^T
  const AT = transpose(A);
  const ATA = multiply(AT, A);
  const ATAInv = inverse(ATA);
  const ATAInvAT = multiply(ATAInv, AT);

  // 提取导数系数
  const derivativeCoeffs = ATAInvAT[derivativeOrder];
  
  // 乘以阶乘
  let factorial = 1;
  for (let i = 1; i <= derivativeOrder; i++) {
    factorial *= i;
  }

  for (let i = 0; i < windowSize; i++) {
    coefficients.push(derivativeCoeffs[i] * factorial);
  }

  return coefficients;
}

/**
 * 矩阵转置
 */
function transpose(matrix: number[][]): number[][] {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result: number[][] = [];

  for (let j = 0; j < cols; j++) {
    const row: number[] = [];
    for (let i = 0; i < rows; i++) {
      row.push(matrix[i][j]);
    }
    result.push(row);
  }

  return result;
}

/**
 * 矩阵乘法
 */
function multiply(A: number[][], B: number[][]): number[][] {
  const rowsA = A.length;
  const colsA = A[0].length;
  const colsB = B[0].length;
  const result: number[][] = [];

  for (let i = 0; i < rowsA; i++) {
    const row: number[] = [];
    for (let j = 0; j < colsB; j++) {
      let sum = 0;
      for (let k = 0; k < colsA; k++) {
        sum += A[i][k] * B[k][j];
      }
      row.push(sum);
    }
    result.push(row);
  }

  return result;
}

/**
 * 矩阵求逆（使用高斯-约旦消元法）
 */
function inverse(matrix: number[][]): number[][] {
  const n = matrix.length;
  const augmented: number[][] = [];

  // 创建增广矩阵
  for (let i = 0; i < n; i++) {
    augmented.push([...matrix[i]]);
    for (let j = 0; j < n; j++) {
      augmented[i].push(i === j ? 1 : 0);
    }
  }

  // 高斯消元
  for (let i = 0; i < n; i++) {
    // 找到主元
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
        maxRow = k;
      }
    }

    // 交换行
    [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

    // 归一化
    const pivot = augmented[i][i];
    if (Math.abs(pivot) < 1e-10) {
      throw new Error('矩阵不可逆');
    }
    for (let j = 0; j < 2 * n; j++) {
      augmented[i][j] /= pivot;
    }

    // 消元
    for (let k = 0; k < n; k++) {
      if (k !== i) {
        const factor = augmented[k][i];
        for (let j = 0; j < 2 * n; j++) {
          augmented[k][j] -= factor * augmented[i][j];
        }
      }
    }
  }

  // 提取逆矩阵
  const result: number[][] = [];
  for (let i = 0; i < n; i++) {
    result.push(augmented[i].slice(n));
  }

  return result;
}

/**
 * Savitzky-Golay 滤波器
 * 专业实现，支持不同多项式阶数
 */
export function savitzkyGolay(
  data: number[],
  windowSize: number,
  polynomialOrder: number = 2
): number[] {
  // 参数验证和调整
  if (windowSize < 3) {
    windowSize = 3;
  }
  if (windowSize % 2 === 0) {
    windowSize++; // 必须是奇数
  }
  if (polynomialOrder >= windowSize) {
    polynomialOrder = windowSize - 1;
  }
  if (polynomialOrder < 1) {
    polynomialOrder = 1;
  }

  if (windowSize > data.length) {
    return [...data];
  }

  const result: number[] = [];
  const halfWindow = Math.floor(windowSize / 2);

  // 计算滤波器系数
  let coeffs: number[];
  try {
    coeffs = computeSGCoefficients(windowSize, polynomialOrder, 0);
  } catch {
    // 如果计算失败，使用简单移动平均
    return movingAverage(data, windowSize);
  }

  // 应用卷积
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let weightSum = 0;

    for (let j = 0; j < windowSize; j++) {
      const idx = i - halfWindow + j;
      
      if (idx >= 0 && idx < data.length) {
        sum += coeffs[j] * data[idx];
        weightSum += coeffs[j];
      } else {
        // 边界处理：镜像扩展
        let mirrorIdx: number;
        if (idx < 0) {
          mirrorIdx = -idx;
        } else {
          mirrorIdx = 2 * data.length - idx - 2;
        }
        
        if (mirrorIdx >= 0 && mirrorIdx < data.length) {
          sum += coeffs[j] * data[mirrorIdx];
          weightSum += coeffs[j];
        }
      }
    }

    result.push(weightSum !== 0 ? sum / weightSum : data[i]);
  }

  return result;
}

/**
 * 移动平均平滑
 */
export function movingAverage(data: number[], windowSize: number): number[] {
  if (windowSize < 1 || windowSize > data.length) {
    return [...data];
  }

  const result: number[] = [];
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let count = 0;

    for (
      let j = Math.max(0, i - half);
      j <= Math.min(data.length - 1, i + half);
      j++
    ) {
      sum += data[j];
      count++;
    }

    result.push(sum / count);
  }

  return result;
}

/**
 * 高斯平滑
 */
export function gaussianSmoothing(data: number[], sigma: number): number[] {
  if (sigma <= 0) {
    return [...data];
  }

  const result: number[] = [];
  const kernelSize = Math.ceil(sigma * 3) * 2 + 1;
  const half = Math.floor(kernelSize / 2);

  // 生成高斯核
  const kernel: number[] = [];
  let kernelSum = 0;

  for (let i = -half; i <= half; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(weight);
    kernelSum += weight;
  }

  // 归一化核
  const normalizedKernel = kernel.map((k) => k / kernelSum);

  // 应用卷积
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < kernelSize; j++) {
      const idx = i - half + j;
      if (idx >= 0 && idx < data.length) {
        sum += normalizedKernel[j] * data[idx];
      } else {
        // 边界处理：镜像
        const mirrorIdx =
          idx < 0 ? -idx : 2 * data.length - idx - 2;
        if (mirrorIdx >= 0 && mirrorIdx < data.length) {
          sum += normalizedKernel[j] * data[mirrorIdx];
        }
      }
    }
    result.push(sum);
  }

  return result;
}

/**
 * 平滑方法枚举
 */
export enum SmoothingMethod {
  NONE = 'none',
  MOVING_AVERAGE = 'moving_average',
  SAVITZKY_GOLAY = 'savitzky_golay',
  GAUSSIAN = 'gaussian',
}

/**
 * 应用平滑处理
 */
export function applySmoothing(
  data: number[],
  method: SmoothingMethod,
  params: {
    windowSize?: number;
    polynomialOrder?: number;
    sigma?: number;
  }
): number[] {
  switch (method) {
    case SmoothingMethod.MOVING_AVERAGE:
      return movingAverage(data, params.windowSize || 5);

    case SmoothingMethod.SAVITZKY_GOLAY:
      return savitzkyGolay(
        data,
        params.windowSize || 7,
        params.polynomialOrder || 2
      );

    case SmoothingMethod.GAUSSIAN:
      return gaussianSmoothing(data, params.sigma || 1);

    case SmoothingMethod.NONE:
    default:
      return [...data];
  }
}
