/**
 * 峰检测工具函数
 * 提供多种寻峰方法，用于自动识别差分曲线中的峰位置、峰强和峰位
 */

export interface Peak {
  index: number;        // 峰在数据数组中的索引
  position: number;     // 峰位（x坐标值）
  height: number;       // 峰高（y坐标值）
  intensity: number;    // 峰强（相对于基线的高度）
  width?: number;       // 峰宽（可选）
  area?: number;        // 峰面积（可选）
  distanceFromStart?: number;  // 峰与横坐标起点的距离
  distanceToNext?: number;     // 与下一个峰的距离
  intervalStart?: number;      // 峰区间起始位置
  intervalEnd?: number;        // 峰区间结束位置
}

// 寻峰方法类型
export type PeakDetectionMethod = 'local_extrema' | 'derivative' | 'window' | 'zero_crossing' | 'scipy_style' | 'shoulder' | 'curvature' | 'second_derivative';

export interface PeakDetectionParams {
  method: PeakDetectionMethod;        // 寻峰方法
  minHeight: number;                  // 最小峰高（原始单位）
  minDistance: number;                // 峰之间的最小距离（x轴单位）
  prominence: number;                 // 峰的显著性阈值（原始单位）
  windowSize: number;                 // 窗口大小（用于窗口平均法）
  enableNegativePeaks: boolean;       // 是否检测负峰（波谷）
}

/**
 * 默认峰检测参数
 */
export const defaultPeakParams = (): PeakDetectionParams => ({
  method: 'local_extrema',
  minHeight: 0,          // 不过滤
  minDistance: 0.01,     // x轴最小距离
  prominence: 0,         // 不过滤
  windowSize: 5,         // 窗口大小
  enableNegativePeaks: false,
});

/**
 * 计算数据的统计范围
 */
function getDataRange(data: number[]): { min: number; max: number; range: number } {
  const validData = data.filter(v => isFinite(v));
  const min = Math.min(...validData);
  const max = Math.max(...validData);
  return { min, max, range: max - min };
}

/**
 * 方法1：局部极值法
 * 简单的局部最大值检测，检查每个点是否比相邻点高
 */
function detectPeaksLocalExtrema(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  for (let i = 1; i < n - 1; i++) {
    // 检查是否为局部极大值（比左右邻居都高）
    if (y[i] > y[i - 1] && y[i] > y[i + 1]) {
      // 检查是否满足最小峰高
      if (y[i] >= params.minHeight) {
        // 检查周围范围内是否有更高的点
        let isMax = true;
        const start = Math.max(0, i - minIndexDistance);
        const end = Math.min(n - 1, i + minIndexDistance);
        
        for (let j = start; j <= end; j++) {
          if (j !== i && y[j] > y[i]) {
            isMax = false;
            break;
          }
        }
        
        if (isMax) {
          peakIndices.push(i);
        }
      }
    }
  }
  
  return peakIndices;
}

/**
 * 方法2：导数法
 * 通过一阶导数符号变化识别峰（从正变负）
 */
function detectPeaksDerivative(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  
  // 计算一阶导数
  const derivatives: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    derivatives.push((y[i + 1] - y[i - 1]) / (x[i + 1] - x[i - 1]));
  }
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  // 找导数从正变负的点
  for (let i = 1; i < derivatives.length; i++) {
    if (derivatives[i - 1] > 0 && derivatives[i] < 0) {
      const peakIdx = i; // 峰在原始数组中的索引
      if (y[peakIdx] >= params.minHeight) {
        // 检查周围是否有更高的点
        let isMax = true;
        const start = Math.max(0, peakIdx - minIndexDistance);
        const end = Math.min(n - 1, peakIdx + minIndexDistance);
        
        for (let j = start; j <= end; j++) {
          if (j !== peakIdx && y[j] > y[peakIdx]) {
            isMax = false;
            break;
          }
        }
        
        if (isMax) {
          peakIndices.push(peakIdx);
        }
      }
    }
  }
  
  return peakIndices;
}

/**
 * 方法3：窗口平均法
 * 在窗口内比较中心点与窗口平均值
 */
function detectPeaksWindow(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  const halfWindow = Math.floor(params.windowSize / 2);
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  for (let i = halfWindow; i < n - halfWindow; i++) {
    // 计算窗口平均值
    let sum = 0;
    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      sum += y[j];
    }
    const avg = sum / (2 * halfWindow + 1);
    
    // 检查中心点是否明显高于平均值
    if (y[i] > avg && y[i] >= params.minHeight) {
      // 检查是否是局部最大值
      let isMax = true;
      const start = Math.max(0, i - minIndexDistance);
      const end = Math.min(n - 1, i + minIndexDistance);
      
      for (let j = start; j <= end; j++) {
        if (j !== i && y[j] > y[i]) {
          isMax = false;
          break;
        }
      }
      
      if (isMax) {
        peakIndices.push(i);
      }
    }
  }
  
  return peakIndices;
}

/**
 * 方法4：导数零交叉法
 * 更精确的导数零点检测
 */
function detectPeaksZeroCrossing(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  
  // 计算一阶导数（使用更高阶的差分）
  const derivatives: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    // 五点差分公式
    derivatives.push(
      (-y[i + 2] + 8 * y[i + 1] - 8 * y[i - 1] + y[i - 2]) / 
      (12 * (x[i + 1] - x[i]))
    );
  }
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  // 找零交叉点（从正变负）
  for (let i = 1; i < derivatives.length; i++) {
    if (derivatives[i - 1] > 0 && derivatives[i] < 0) {
      const peakIdx = i + 2; // 调整索引
      if (y[peakIdx] >= params.minHeight) {
        // 检查周围是否有更高的点
        let isMax = true;
        const start = Math.max(0, peakIdx - minIndexDistance);
        const end = Math.min(n - 1, peakIdx + minIndexDistance);
        
        for (let j = start; j <= end; j++) {
          if (j !== peakIdx && y[j] > y[peakIdx]) {
            isMax = false;
            break;
          }
        }
        
        if (isMax) {
          peakIndices.push(peakIdx);
        }
      }
    }
  }
  
  return peakIndices;
}

/**
 * 方法5：Scipy风格寻峰
 * 类似于 scipy.signal.find_peaks 的实现
 */
function detectPeaksScipyStyle(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  // 第一步：找到所有局部极大值
  const candidates: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (y[i] >= y[i - 1] && y[i] >= y[i + 1]) {
      // 处理平台（连续相等的点）
      if (y[i] === y[i - 1] || y[i] === y[i + 1]) {
        // 找到平台的中心
        let left = i, right = i;
        while (left > 0 && y[left - 1] === y[i]) left--;
        while (right < n - 1 && y[right + 1] === y[i]) right++;
        const center = Math.floor((left + right) / 2);
        if (center === i) candidates.push(i);
      } else {
        candidates.push(i);
      }
    }
  }
  
  // 第二步：应用最小距离过滤
  if (candidates.length === 0) return [];
  
  // 按高度降序排序
  candidates.sort((a, b) => y[b] - y[a]);
  
  const accepted: number[] = [];
  const rejected = new Set<number>();
  
  for (const idx of candidates) {
    if (rejected.has(idx)) continue;
    
    // 检查最小峰高
    if (y[idx] < params.minHeight) {
      rejected.add(idx);
      continue;
    }
    
    accepted.push(idx);
    
    // 标记附近的候选点为拒绝
    const start = Math.max(0, idx - minIndexDistance);
    const end = Math.min(n - 1, idx + minIndexDistance);
    for (let j = start; j <= end; j++) {
      if (j !== idx && candidates.includes(j)) {
        rejected.add(j);
      }
    }
  }
  
  // 按位置排序
  accepted.sort((a, b) => a - b);
  
  return accepted;
}

/**
 * 方法6：肩膀峰检测法
 * 检测斜坡上的凸起（肩峰），即使不是局部最大值也能识别
 * 通过检测斜率变化来识别肩膀峰
 */
function detectPeaksShoulder(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  
  if (n < 5) return peakIndices;
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  // 计算一阶导数（斜率）
  const slopes: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    slopes.push((y[i + 1] - y[i - 1]) / (x[i + 1] - x[i - 1]));
  }
  
  // 计算斜率的变化率（二阶导数的近似）
  const slopeChanges: number[] = [];
  for (let i = 1; i < slopes.length - 1; i++) {
    slopeChanges.push(slopes[i + 1] - slopes[i - 1]);
  }
  
  // 检测肩膀峰的特征：
  // 1. 斜率从负变平或从负变正再变负（形成凸起）
  // 2. 在下降趋势中（整体斜率为负）
  // 3. 有明显的曲率变化
  
  for (let i = 2; i < n - 2; i++) {
    const slopeIdx = i - 1;
    const slopeChangeIdx = i - 2;
    
    if (slopeIdx < 0 || slopeIdx >= slopes.length) continue;
    if (slopeChangeIdx < 0 || slopeChangeIdx >= slopeChanges.length) continue;
    
    const currentSlope = slopes[slopeIdx];
    const currentSlopeChange = slopeChanges[slopeChangeIdx];
    
    // 条件1：在下降趋势中（斜率为负）
    const isDescending = currentSlope < 0;
    
    // 条件2：斜率变化为正（形成凸起）
    const hasConvexity = currentSlopeChange > 0;
    
    // 条件3：检查是否形成肩膀形状
    // 左边斜率更负，右边斜率更负，中间斜率较大
    const leftSlope = slopes[Math.max(0, slopeIdx - 2)];
    const rightSlope = slopes[Math.min(slopes.length - 1, slopeIdx + 2)];
    const isShoulder = leftSlope < currentSlope && rightSlope < currentSlope;
    
    // 条件4：满足最小峰高
    const meetsHeight = y[i] >= params.minHeight;
    
    if (isDescending && hasConvexity && isShoulder && meetsHeight) {
      // 检查周围是否已经有更高的候选点
      let isUnique = true;
      const start = Math.max(0, i - minIndexDistance);
      const end = Math.min(n - 1, i + minIndexDistance);
      
      for (let j = start; j <= end; j++) {
        if (j !== i && peakIndices.includes(j)) {
          // 保留较高的那个
          if (y[j] > y[i]) {
            isUnique = false;
            break;
          }
        }
      }
      
      if (isUnique) {
        peakIndices.push(i);
      }
    }
  }
  
  // 同时检测正常的局部极大值
  for (let i = 1; i < n - 1; i++) {
    if (y[i] > y[i - 1] && y[i] > y[i + 1] && y[i] >= params.minHeight) {
      let isMax = true;
      const start = Math.max(0, i - minIndexDistance);
      const end = Math.min(n - 1, i + minIndexDistance);
      
      for (let j = start; j <= end; j++) {
        if (j !== i && y[j] > y[i]) {
          isMax = false;
          break;
        }
      }
      
      if (isMax && !peakIndices.includes(i)) {
        peakIndices.push(i);
      }
    }
  }
  
  peakIndices.sort((a, b) => a - b);
  return peakIndices;
}

/**
 * 方法7：曲率法
 * 基于曲率变化检测峰，能够识别肩峰
 */
function detectPeaksCurvature(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  
  if (n < 5) return peakIndices;
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  // 计算曲率 κ = y'' / (1 + y'^2)^(3/2)
  // 简化：只考虑 y'' 的符号和大小
  const curvatures: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    // 二阶导数（曲率近似）
    const d2y = (y[i + 2] - 2 * y[i] + y[i - 2]) / Math.pow(x[i + 1] - x[i], 2);
    curvatures.push(d2y);
  }
  
  // 检测曲率极小值点（负曲率区域）
  for (let i = 1; i < curvatures.length - 1; i++) {
    const originalIdx = i + 2;
    
    // 曲率为负（凸起）且是局部极小值
    const isCurvatureMin = curvatures[i] < curvatures[i - 1] && curvatures[i] < curvatures[i + 1];
    const isConcave = curvatures[i] < 0;
    
    if (isCurvatureMin && isConcave && y[originalIdx] >= params.minHeight) {
      // 检查周围是否已经有候选点
      let isUnique = true;
      const start = Math.max(0, originalIdx - minIndexDistance);
      const end = Math.min(n - 1, originalIdx + minIndexDistance);
      
      for (let j = start; j <= end; j++) {
        if (j !== originalIdx && peakIndices.includes(j)) {
          if (y[j] >= y[originalIdx]) {
            isUnique = false;
            break;
          }
        }
      }
      
      if (isUnique) {
        peakIndices.push(originalIdx);
      }
    }
  }
  
  // 合并检测局部极大值
  for (let i = 1; i < n - 1; i++) {
    if (y[i] > y[i - 1] && y[i] > y[i + 1] && y[i] >= params.minHeight) {
      if (!peakIndices.includes(i)) {
        // 检查周围
        let isMax = true;
        const start = Math.max(0, i - minIndexDistance);
        const end = Math.min(n - 1, i + minIndexDistance);
        
        for (let j = start; j <= end; j++) {
          if (j !== i && y[j] > y[i]) {
            isMax = false;
            break;
          }
        }
        
        if (isMax) {
          peakIndices.push(i);
        }
      }
    }
  }
  
  peakIndices.sort((a, b) => a - b);
  return peakIndices;
}

/**
 * 方法8：二阶导数法
 * 通过二阶导数的负值区域识别峰（包括肩峰）
 */
function detectPeaksSecondDerivative(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  const n = y.length;
  const peakIndices: number[] = [];
  
  if (n < 5) return peakIndices;
  
  // 将最小距离转换为索引间隔
  const avgInterval = n > 1 ? (x[n - 1] - x[0]) / (n - 1) : 1;
  const minIndexDistance = Math.max(1, Math.round(params.minDistance / avgInterval));
  
  // 计算二阶导数
  const secondDerivs: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    // 使用五点差分公式计算二阶导数
    const h = x[i + 1] - x[i];
    const d2y = (y[i + 2] - 2 * y[i + 1] + y[i] + y[i] - 2 * y[i - 1] + y[i - 2]) / (h * h * 4);
    secondDerivs.push(d2y);
  }
  
  // 寻找二阶导数的极小值点（负曲率区域）
  for (let i = 1; i < secondDerivs.length - 1; i++) {
    const originalIdx = i + 2;
    
    // 二阶导数为负且是局部极小值
    const isNegative = secondDerivs[i] < 0;
    const isLocalMin = secondDerivs[i] < secondDerivs[i - 1] && secondDerivs[i] < secondDerivs[i + 1];
    
    // 或者二阶导数从负变正（拐点）
    const isInflection = secondDerivs[i - 1] < 0 && secondDerivs[i + 1] > 0;
    
    if ((isNegative && isLocalMin) || isInflection) {
      if (y[originalIdx] >= params.minHeight) {
        // 检查周围
        let isUnique = true;
        const start = Math.max(0, originalIdx - minIndexDistance);
        const end = Math.min(n - 1, originalIdx + minIndexDistance);
        
        for (let j = start; j <= end; j++) {
          if (j !== originalIdx && peakIndices.includes(j)) {
            if (y[j] >= y[originalIdx]) {
              isUnique = false;
              break;
            }
          }
        }
        
        if (isUnique) {
          peakIndices.push(originalIdx);
        }
      }
    }
  }
  
  // 合并检测局部极大值
  for (let i = 1; i < n - 1; i++) {
    if (y[i] > y[i - 1] && y[i] > y[i + 1] && y[i] >= params.minHeight) {
      if (!peakIndices.includes(i)) {
        let isMax = true;
        const start = Math.max(0, i - minIndexDistance);
        const end = Math.min(n - 1, i + minIndexDistance);
        
        for (let j = start; j <= end; j++) {
          if (j !== i && y[j] > y[i]) {
            isMax = false;
            break;
          }
        }
        
        if (isMax) {
          peakIndices.push(i);
        }
      }
    }
  }
  
  peakIndices.sort((a, b) => a - b);
  return peakIndices;
}

/**
 * 计算峰的显著性（Prominence）
 */
function calculateProminence(y: number[], peakIndex: number): number {
  const peakHeight = y[peakIndex];
  const n = y.length;
  
  // 向左查找基线
  let leftBaseline = y[0];
  for (let i = peakIndex - 1; i >= 0; i--) {
    if (y[i] < leftBaseline) {
      leftBaseline = y[i];
    }
    if (y[i] > peakHeight) break;
  }
  
  // 向右查找基线
  let rightBaseline = y[n - 1];
  for (let i = peakIndex + 1; i < n; i++) {
    if (y[i] < rightBaseline) {
      rightBaseline = y[i];
    }
    if (y[i] > peakHeight) break;
  }
  
  const baseline = Math.max(leftBaseline, rightBaseline);
  return peakHeight - baseline;
}

/**
 * 计算峰宽（半高宽）
 */
function calculatePeakWidth(x: number[], y: number[], peakIndex: number, baseline: number): number {
  const peakHeight = y[peakIndex];
  const halfHeight = baseline + (peakHeight - baseline) / 2;
  
  let leftIndex = peakIndex;
  for (let i = peakIndex - 1; i >= 0; i--) {
    if (y[i] < halfHeight) {
      const t = (halfHeight - y[i]) / (y[i + 1] - y[i]);
      leftIndex = i + t;
      break;
    }
  }
  
  let rightIndex = peakIndex;
  for (let i = peakIndex + 1; i < y.length; i++) {
    if (y[i] < halfHeight) {
      const t = (halfHeight - y[i - 1]) / (y[i] - y[i - 1]);
      rightIndex = i - 1 + t;
      break;
    }
  }
  
  const width = x[Math.floor(rightIndex)] - x[Math.floor(leftIndex)];
  return isFinite(width) ? width : 0;
}

/**
 * 计算峰面积
 */
function calculatePeakArea(x: number[], y: number[], peakIndex: number, baseline: number): number {
  let leftBound = 0;
  for (let i = peakIndex - 1; i >= 0; i--) {
    if (y[i] <= baseline) {
      leftBound = i;
      break;
    }
  }
  
  let rightBound = y.length - 1;
  for (let i = peakIndex + 1; i < y.length; i++) {
    if (y[i] <= baseline) {
      rightBound = i;
      break;
    }
  }
  
  let area = 0;
  for (let i = leftBound; i < rightBound; i++) {
    const h1 = y[i] - baseline;
    const h2 = y[i + 1] - baseline;
    const w = x[i + 1] - x[i];
    area += (h1 + h2) * w / 2;
  }
  
  return area;
}

/**
 * 查找局部极小值点（负峰）
 */
function findLocalMinima(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): number[] {
  // 反转数据，找最大值
  const negY = y.map(v => -v);
  const negParams = { ...params, minHeight: -params.minHeight };
  
  // 根据方法选择检测函数
  switch (params.method) {
    case 'derivative':
      return detectPeaksDerivative(x, negY, negParams);
    case 'window':
      return detectPeaksWindow(x, negY, negParams);
    case 'zero_crossing':
      return detectPeaksZeroCrossing(x, negY, negParams);
    case 'scipy_style':
      return detectPeaksScipyStyle(x, negY, negParams);
    case 'shoulder':
      return detectPeaksShoulder(x, negY, negParams);
    case 'curvature':
      return detectPeaksCurvature(x, negY, negParams);
    case 'second_derivative':
      return detectPeaksSecondDerivative(x, negY, negParams);
    default:
      return detectPeaksLocalExtrema(x, negY, negParams);
  }
}

/**
 * 检测峰（主函数）
 */
export function detectPeaks(
  x: number[],
  y: number[],
  params: PeakDetectionParams
): Peak[] {
  if (x.length !== y.length) {
    throw new Error('x 和 y 数据长度不一致');
  }
  
  const peaks: Peak[] = [];
  
  // 根据方法选择检测函数
  let peakIndices: number[];
  switch (params.method) {
    case 'derivative':
      peakIndices = detectPeaksDerivative(x, y, params);
      break;
    case 'window':
      peakIndices = detectPeaksWindow(x, y, params);
      break;
    case 'zero_crossing':
      peakIndices = detectPeaksZeroCrossing(x, y, params);
      break;
    case 'scipy_style':
      peakIndices = detectPeaksScipyStyle(x, y, params);
      break;
    case 'shoulder':
      peakIndices = detectPeaksShoulder(x, y, params);
      break;
    case 'curvature':
      peakIndices = detectPeaksCurvature(x, y, params);
      break;
    case 'second_derivative':
      peakIndices = detectPeaksSecondDerivative(x, y, params);
      break;
    default:
      peakIndices = detectPeaksLocalExtrema(x, y, params);
  }
  
  // 构建峰对象，应用显著性过滤
  for (const idx of peakIndices) {
    const prominence = calculateProminence(y, idx);
    
    // 应用显著性阈值过滤
    if (prominence >= params.prominence) {
      const baseline = y[idx] - prominence;
      const width = calculatePeakWidth(x, y, idx, baseline);
      const area = calculatePeakArea(x, y, idx, baseline);
      
      peaks.push({
        index: idx,
        position: x[idx],
        height: y[idx],
        intensity: prominence,
        width,
        area,
      });
    }
  }
  
  // 检测负峰（波谷）
  if (params.enableNegativePeaks) {
    const minimaIndices = findLocalMinima(x, y, params);
    
    for (const idx of minimaIndices) {
      const prominence = calculateProminence(y.map(v => -v), idx);
      
      if (prominence >= params.prominence) {
        const baseline = y[idx] + prominence;
        const width = calculatePeakWidth(x, y, idx, baseline);
        const area = Math.abs(calculatePeakArea(x, y, idx, baseline));
        
        peaks.push({
          index: idx,
          position: x[idx],
          height: y[idx],
          intensity: prominence,
          width,
          area,
        });
      }
    }
  }
  
  // 按峰位排序
  peaks.sort((a, b) => a.position - b.position);
  
  return peaks;
}

/**
 * 计算峰之间的距离
 */
export function calculatePeakDistances(peaks: Peak[], xStart: number): Peak[] {
  if (peaks.length === 0) return peaks;
  
  // 按位置排序
  const sortedPeaks = [...peaks].sort((a, b) => a.position - b.position);
  
  sortedPeaks.forEach((peak, i) => {
    // 峰与横坐标起点的距离
    peak.distanceFromStart = peak.position - xStart;
    // 与下一个峰的距离
    if (i < sortedPeaks.length - 1) {
      peak.distanceToNext = sortedPeaks[i + 1].position - peak.position;
    }
  });
  
  return sortedPeaks;
}

/**
 * 计算峰区间（基于半峰高宽度，避免相邻峰区间重叠）
 */
export function calculatePeakIntervals(peaks: Peak[], x: number[], y: number[]): Peak[] {
  if (peaks.length === 0 || x.length === 0) return peaks;
  
  // 按位置排序
  const sortedPeaks = [...peaks].sort((a, b) => a.position - b.position);
  
  const baseline = Math.min(...y.filter(v => isFinite(v))); // 基线（最小值）
  
  sortedPeaks.forEach((peak, peakIdx) => {
    const halfHeight = baseline + (peak.height - baseline) * 0.5; // 半峰高
    
    // 计算允许的最大区间边界（不超过相邻峰的中点）
    let maxLeft = x[0];
    let maxRight = x[x.length - 1];
    
    // 左边界不超过与前一个峰的中点
    if (peakIdx > 0) {
      const prevPeak = sortedPeaks[peakIdx - 1];
      maxLeft = (prevPeak.position + peak.position) / 2;
    }
    
    // 右边界不超过与后一个峰的中点
    if (peakIdx < sortedPeaks.length - 1) {
      const nextPeak = sortedPeaks[peakIdx + 1];
      maxRight = (peak.position + nextPeak.position) / 2;
    }
    
    // 向左找区间起点
    let startIdx = peak.index;
    for (let i = peak.index - 1; i >= 0; i--) {
      if (y[i] < halfHeight || x[i] <= maxLeft) {
        startIdx = i;
        break;
      }
    }
    
    // 向右找区间终点
    let endIdx = peak.index;
    for (let i = peak.index + 1; i < y.length; i++) {
      if (y[i] < halfHeight || x[i] >= maxRight) {
        endIdx = i;
        break;
      }
    }
    
    // 确保区间不超过相邻峰边界
    peak.intervalStart = Math.max(x[startIdx], maxLeft);
    peak.intervalEnd = Math.min(x[endIdx], maxRight);
    peak.width = peak.intervalEnd - peak.intervalStart;
  });
  
  return peaks;
}

/**
 * 格式化峰数据为表格字符串
 */
export function formatPeaksTable(
  peaks: Peak[],
  xLabel: string,
  yLabel: string
): string {
  if (peaks.length === 0) {
    return '未检测到峰';
  }
  
  const lines: string[] = [];
  lines.push(`峰编号\t${xLabel}\t${yLabel}\t峰强\t区间起点\t区间终点\t峰宽\t距起点\t距下峰`);
  
  peaks.forEach((peak, i) => {
    const intervalStart = peak.intervalStart !== undefined ? peak.intervalStart.toFixed(4) : '-';
    const intervalEnd = peak.intervalEnd !== undefined ? peak.intervalEnd.toFixed(4) : '-';
    const width = peak.width !== undefined ? peak.width.toFixed(4) : '-';
    const distFromStart = peak.distanceFromStart !== undefined ? peak.distanceFromStart.toFixed(4) : '-';
    const distToNext = peak.distanceToNext !== undefined ? peak.distanceToNext.toFixed(4) : '-';
    lines.push(
      `${i + 1}\t${peak.position.toFixed(4)}\t${peak.height.toFixed(6)}\t` +
      `${peak.intensity.toFixed(6)}\t${intervalStart}\t${intervalEnd}\t${width}\t${distFromStart}\t${distToNext}`
    );
  });
  
  return lines.join('\n');
}

/**
 * 导出峰数据为CSV格式
 */
export function exportPeaksCSV(
  peaks: Peak[],
  xLabel: string,
  yLabel: string
): string {
  const lines: string[] = [];
  lines.push(`峰编号,${xLabel},${yLabel},峰强,区间起点,区间终点,峰宽`);
  
  peaks.forEach((peak, i) => {
    const intervalStart = peak.intervalStart !== undefined ? peak.intervalStart.toFixed(6) : '';
    const intervalEnd = peak.intervalEnd !== undefined ? peak.intervalEnd.toFixed(6) : '';
    const width = peak.width !== undefined ? peak.width.toFixed(6) : '';
    lines.push(
      `${i + 1},${peak.position.toFixed(6)},${peak.height.toFixed(8)},` +
      `${peak.intensity.toFixed(8)},${intervalStart},${intervalEnd},${width}`
    );
  });
  
  return lines.join('\n');
}
