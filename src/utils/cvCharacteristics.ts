/**
 * 恒压阶段特征常数提取工具
 * 基于 Ko et al. (2024) "Differential current in constant-voltage charging mode"
 */

export interface CVCharacteristics {
  // 基本参数
  initialCurrent: number;      // 初始电流 I₀ (A)
  finalCurrent: number;        // 最终电流 I_end (A)
  capacityGain: number;        // 容量增量 ΔQ (Ah)
  cvDuration: number;          // CV阶段持续时间 (s)
  
  // 拟合参数
  timeConstant: number;        // 时间常数 τ (s) - 描述电流衰减速度
  decayRate: number;           // 衰减率 λ (1/s)
  fittedCurrent: number[];     // 拟合电流曲线
  fittedCapacity: number[];    // 拟合容量曲线
  
  // 差分电流特征
  dqdiMax: number;             // dQ/dI 最大值
  dqdiMean: number;            // dQ/dI 平均值
  didqPeak: number;            // dI/dQ 峰值
  didqPeakCapacity: number;    // dI/dQ 峰值对应的容量
  
  // 能量特征
  energyConsumed: number;      // 消耗的能量 (Wh)
  avgVoltage: number;          // 平均电压 (V)
  
  // 拟合质量
  r2Score: number;             // 拟合优度 R²
  
  // 分离指数（用于SOH估计）
  separationIndex: number;     // 分离指数 SI
}

/**
 * 计算恒压阶段的特征常数
 * 
 * @param current - 电流数组 (A)，应该是单调递减的
 * @param capacity - 容量数组 (Ah)
 * @param voltage - 电压数组 (V)
 * @param time - 时间数组 (s)
 * @returns CVCharacteristics 特征常数
 */
export function calculateCVCharacteristics(
  current: number[],
  capacity: number[],
  voltage?: number[],
  time?: number[]
): CVCharacteristics {
  if (current.length < 5) {
    throw new Error('数据点太少，至少需要5个点');
  }

  if (current.length !== capacity.length) {
    throw new Error('电流和容量数组长度不一致');
  }

  console.log('开始计算恒压阶段特征常数，数据点数:', current.length);

  // 1. 基本参数
  const initialCurrent = current[0];
  const finalCurrent = current[current.length - 1];
  const capacityGain = capacity[capacity.length - 1] - capacity[0];
  
  // 计算持续时间
  let cvDuration: number;
  if (time && time.length > 0) {
    cvDuration = time[time.length - 1] - time[0];
  } else {
    cvDuration = current.length; // 假设采样间隔为1秒
  }

  console.log('基本参数:', {
    initialCurrent: initialCurrent.toFixed(2),
    finalCurrent: finalCurrent.toFixed(2),
    capacityGain: capacityGain.toFixed(2),
    cvDuration: cvDuration.toFixed(0)
  });

  // 2. 拟合指数衰减模型: I(t) = I₀ * exp(-t/τ)
  const timeArray = time || current.map((_, i) => i);
  const fittedCurrent = fitExponentialDecay(timeArray, current);
  const timeConstant = extractTimeConstant(timeArray, fittedCurrent);
  const decayRate = 1 / timeConstant;

  console.log('时间常数:', {
    timeConstant: timeConstant.toFixed(2),
    decayRate: decayRate.toFixed(4)
  });

  // 3. 计算拟合容量曲线（通过积分）
  const fittedCapacity = integrateCurrent(fittedCurrent, timeArray);
  const r2Score = calculateR2(capacity, fittedCapacity);

  console.log('拟合质量:', { r2Score: r2Score.toFixed(4) });

  // 4. 计算dQ/dI特征
  const dqdiResult = calculateDqdiCharacteristics(fittedCurrent, fittedCapacity);
  
  console.log('dQ/dI特征:', {
    dqdiMax: dqdiResult.dqdiMax.toFixed(4),
    dqdiMean: dqdiResult.dqdiMean.toFixed(4),
    didqPeak: dqdiResult.didqPeak.toFixed(4)
  });

  // 5. 计算能量特征（如果有电压数据）
  let energyConsumed = 0;
  let avgVoltage = 0;
  
  if (voltage && voltage.length === current.length) {
    // E = ∫ V(t) * I(t) dt
    for (let i = 1; i < voltage.length; i++) {
      const dt = timeArray[i] - timeArray[i - 1];
      const avgV = (voltage[i] + voltage[i - 1]) / 2;
      const avgI = (current[i] + current[i - 1]) / 2;
      energyConsumed += avgV * avgI * dt / 3600; // 转换为Wh
    }
    avgVoltage = voltage.reduce((a, b) => a + b, 0) / voltage.length;
    console.log('能量特征:', {
      energyConsumed: energyConsumed.toFixed(2),
      avgVoltage: avgVoltage.toFixed(2)
    });
  }

  // 6. 计算分离指数（用于SOH估计）
  const separationIndex = calculateSeparationIndex(
    initialCurrent,
    finalCurrent,
    timeConstant,
    capacityGain
  );

  console.log('分离指数:', separationIndex.toFixed(4));

  return {
    initialCurrent,
    finalCurrent,
    capacityGain,
    cvDuration,
    timeConstant,
    decayRate,
    fittedCurrent,
    fittedCapacity,
    dqdiMax: dqdiResult.dqdiMax,
    dqdiMean: dqdiResult.dqdiMean,
    didqPeak: dqdiResult.didqPeak,
    didqPeakCapacity: dqdiResult.didqPeakCapacity,
    energyConsumed,
    avgVoltage,
    r2Score,
    separationIndex,
  };
}

/**
 * 拟合指数衰减模型
 * I(t) = I₀ * exp(-t/τ)
 */
function fitExponentialDecay(
  time: number[],
  current: number[]
): number[] {
  const t0 = time[0];
  const I0 = current[0];
  
  // 线性化: ln(I) = ln(I₀) - t/τ
  // 使用最小二乘法拟合
  const n = time.length;
  let sumT = 0, sumLnI = 0, sumTLnI = 0, sumT2 = 0;
  
  for (let i = 0; i < n; i++) {
    const t = time[i] - t0;
    const lnI = Math.log(Math.max(current[i], 1e-10)); // 避免log(0)
    
    sumT += t;
    sumLnI += lnI;
    sumTLnI += t * lnI;
    sumT2 += t * t;
  }
  
  // 最小二乘法: ln(I) = a + b*t
  // b = -1/τ
  const denominator = n * sumT2 - sumT * sumT;
  const b = (n * sumTLnI - sumT * sumLnI) / denominator;
  const a = (sumLnI - b * sumT) / n;
  
  const tau = -1 / b;
  
  // 生成拟合曲线
  return time.map(t => I0 * Math.exp(-(t - t0) / tau));
}

/**
 * 提取时间常数
 */
function extractTimeConstant(
  time: number[],
  fittedCurrent: number[]
): number {
  const t0 = time[0];
  const I0 = fittedCurrent[0];
  
  // 找到电流衰减到I₀/e的点
  const targetCurrent = I0 / Math.E;
  
  for (let i = 0; i < fittedCurrent.length; i++) {
    if (fittedCurrent[i] <= targetCurrent) {
      // 线性插值
      if (i === 0) return time[i] - t0;
      const t1 = time[i - 1] - t0;
      const t2 = time[i] - t0;
      const I1 = fittedCurrent[i - 1];
      const I2 = fittedCurrent[i];
      
      const tau = t1 + (t2 - t1) * (targetCurrent - I1) / (I2 - I1);
      return Math.max(tau, 1); // 避免tau太小
    }
  }
  
  // 如果没找到，使用整体拟合
  return time[time.length - 1] - t0;
}

/**
 * 积分电流得到容量
 * Q(t) = ∫ I(t) dt
 */
function integrateCurrent(
  current: number[],
  time: number[]
): number[] {
  const capacity = [0];
  
  for (let i = 1; i < current.length; i++) {
    const dt = time[i] - time[i - 1];
    const avgI = (current[i] + current[i - 1]) / 2;
    capacity.push(capacity[i - 1] + avgI * dt / 3600); // 转换为Ah
  }
  
  return capacity;
}

/**
 * 计算dQ/dI特征
 */
function calculateDqdiCharacteristics(
  current: number[],
  capacity: number[]
): {
  dqdiMax: number;
  dqdiMean: number;
  didqPeak: number;
  didqPeakCapacity: number;
} {
  // 计算dQ/dI = dQ/dt / (dI/dt)
  const dqdi: number[] = [];
  const didq: number[] = [];
  
  for (let i = 1; i < current.length - 1; i++) {
    const dQ = capacity[i + 1] - capacity[i - 1];
    const dI = current[i + 1] - current[i - 1];
    
    if (Math.abs(dI) > 1e-10) {
      const dqdiValue = dQ / dI;
      dqdi.push(dqdiValue);
      didq.push(Math.abs(dqdiValue) > 1e-10 ? 1 / dqdiValue : 0);
    }
  }
  
  const dqdiMax = dqdi.length > 0 ? Math.max(...dqdi) : 0;
  const dqdiMean = dqdi.length > 0 ? dqdi.reduce((a, b) => a + b, 0) / dqdi.length : 0;
  const didqPeak = didq.length > 0 ? Math.max(...didq) : 0;
  
  // 找到dI/dQ峰值对应的容量
  const peakIndex = didq.indexOf(didqPeak);
  const didqPeakCapacity = peakIndex >= 0 ? capacity[peakIndex + 1] : 0;
  
  return { dqdiMax, dqdiMean, didqPeak, didqPeakCapacity };
}

/**
 * 计算R²拟合优度
 */
function calculateR2(actual: number[], predicted: number[]): number {
  const n = actual.length;
  const mean = actual.reduce((a, b) => a + b, 0) / n;
  
  const ssRes = actual.reduce((sum, y, i) => {
    return sum + Math.pow(y - predicted[i], 2);
  }, 0);
  
  const ssTot = actual.reduce((sum, y) => {
    return sum + Math.pow(y - mean, 2);
  }, 0);
  
  return 1 - ssRes / ssTot;
}

/**
 * 计算分离指数（用于SOH估计）
 * SI = (I₀ - I_end) / (I₀ * τ)
 */
function calculateSeparationIndex(
  initialCurrent: number,
  finalCurrent: number,
  timeConstant: number,
  capacityGain: number
): number {
  // 标准化的分离指数
  const currentDecay = (initialCurrent - finalCurrent) / initialCurrent;
  const normalizedTC = timeConstant / 3600; // 转换为小时
  const normalizedCapacity = capacityGain / initialCurrent;
  
  // 组合指标
  return (currentDecay * normalizedCapacity) / (normalizedTC || 1);
}
