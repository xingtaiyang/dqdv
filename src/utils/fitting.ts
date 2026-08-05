/**
 * 曲线拟合工具函数
 * 先拟合再求导的方法
 */

/**
 * 多项式拟合
 * 返回拟合系数 [a0, a1, a2, ...] 对应 y = a0 + a1*x + a2*x^2 + ...
 */
export function polynomialFit(
  x: number[],
  y: number[],
  degree: number
): number[] {
  const n = x.length;
  if (n <= degree) {
    degree = n - 1;
  }

  // 构建范德蒙矩阵
  const X: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j <= degree; j++) {
      row.push(Math.pow(x[i], j));
    }
    X.push(row);
  }

  // 计算 (X^T * X)^-1 * X^T * y
  const XT = transpose(X);
  const XTX = multiply(XT, X);
  const XTXInv = inverse(XTX);
  const XTy = multiplyVector(XT, y);
  const coeffs = multiplyVector(XTXInv, XTy);

  return coeffs;
}

/**
 * 使用多项式系数计算拟合值
 */
export function polynomialEvaluate(coeffs: number[], x: number): number {
  let result = 0;
  for (let i = 0; i < coeffs.length; i++) {
    result += coeffs[i] * Math.pow(x, i);
  }
  return result;
}

/**
 * 计算多项式导数值
 * 一阶导数：y' = a1 + 2*a2*x + 3*a3*x^2 + ...
 */
export function polynomialDerivative(coeffs: number[], x: number): number {
  let result = 0;
  for (let i = 1; i < coeffs.length; i++) {
    result += i * coeffs[i] * Math.pow(x, i - 1);
  }
  return result;
}

/**
 * B样条拟合
 */
export class BSpline {
  private knots: number[];
  private coeffs: number[];
  private degree: number;
  private xMin: number;
  private xMax: number;

  constructor(x: number[], y: number[], degree: number = 3, numKnots: number = 20) {
    this.degree = degree;
    this.xMin = Math.min(...x);
    this.xMax = Math.max(...x);
    
    // 创建均匀节点
    const internalKnots: number[] = [];
    const step = (this.xMax - this.xMin) / (numKnots - 1);
    for (let i = 0; i < numKnots; i++) {
      internalKnots.push(this.xMin + i * step);
    }
    
    // 扩展节点（边界条件）
    this.knots = [];
    for (let i = 0; i < degree; i++) {
      this.knots.push(this.xMin);
    }
    this.knots.push(...internalKnots);
    for (let i = 0; i < degree; i++) {
      this.knots.push(this.xMax);
    }
    
    // 计算拟合系数（使用最小二乘法）
    const n = x.length;
    const numBasis = this.knots.length - degree - 1;
    
    // 构建 B 样条基函数矩阵
    const B: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < numBasis; j++) {
        row.push(this.basisFunction(j, degree, x[i]));
      }
      B.push(row);
    }
    
    // 最小二乘求解
    const BT = transpose(B);
    const BTB = multiply(BT, B);
    const BTBInv = inverse(BTB);
    const BTy = multiplyVector(BT, y);
    this.coeffs = multiplyVector(BTBInv, BTy);
  }

  /**
   * 计算 B 样条基函数值（Cox-de Boor 递归公式）
   */
  private basisFunction(i: number, p: number, x: number): number {
    if (p === 0) {
      if (this.knots[i] <= x && x < this.knots[i + 1]) {
        return 1;
      }
      if (x === this.knots[this.knots.length - 1] && i === this.knots.length - this.degree - 2) {
        return 1; // 右边界处理
      }
      return 0;
    }

    let left = 0;
    let right = 0;

    const denom1 = this.knots[i + p] - this.knots[i];
    const denom2 = this.knots[i + p + 1] - this.knots[i + 1];

    if (denom1 !== 0) {
      left = ((x - this.knots[i]) / denom1) * this.basisFunction(i, p - 1, x);
    }

    if (denom2 !== 0) {
      right = ((this.knots[i + p + 1] - x) / denom2) * this.basisFunction(i + 1, p - 1, x);
    }

    return left + right;
  }

  /**
   * 计算 B 样条基函数导数
   */
  private basisDerivative(i: number, p: number, x: number): number {
    if (p === 0) {
      return 0;
    }

    let left = 0;
    let right = 0;

    const denom1 = this.knots[i + p] - this.knots[i];
    const denom2 = this.knots[i + p + 1] - this.knots[i + 1];

    if (denom1 !== 0) {
      left = (p / denom1) * this.basisFunction(i, p - 1, x);
    }

    if (denom2 !== 0) {
      right = (-p / denom2) * this.basisFunction(i + 1, p - 1, x);
    }

    return left + right;
  }

  /**
   * 计算拟合值
   */
  evaluate(x: number): number {
    const numBasis = this.coeffs.length;
    let result = 0;
    for (let i = 0; i < numBasis; i++) {
      result += this.coeffs[i] * this.basisFunction(i, this.degree, x);
    }
    return result;
  }

  /**
   * 计算导数值
   */
  derivative(x: number): number {
    const numBasis = this.coeffs.length;
    let result = 0;
    for (let i = 0; i < numBasis; i++) {
      result += this.coeffs[i] * this.basisDerivative(i, this.degree, x);
    }
    return result;
  }
}

/**
 * 三次样条拟合（简化实现，使用自然边界条件）
 */
export class CubicSpline {
  private x: number[];
  private y: number[];
  private a: number[];
  private b: number[];
  private c: number[];
  private d: number[];

  constructor(x: number[], y: number[]) {
    this.x = [...x];
    this.y = [...y];
    const n = x.length;

    // 计算样条系数
    const h: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      h.push(x[i + 1] - x[i]);
    }

    // 构建三对角矩阵求解
    const alpha: number[] = [0];
    for (let i = 1; i < n - 1; i++) {
      alpha.push(
        (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1])
      );
    }

    const l: number[] = [1];
    const mu: number[] = [0];
    const z: number[] = [0];

    for (let i = 1; i < n - 1; i++) {
      l.push(2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1]);
      mu.push(h[i] / l[i]);
      z.push((alpha[i] - h[i - 1] * z[i - 1]) / l[i]);
    }

    l.push(1);
    z.push(0);

    this.a = [...y];
    this.c = new Array(n).fill(0);
    this.b = new Array(n - 1).fill(0);
    this.d = new Array(n - 1).fill(0);

    for (let j = n - 2; j >= 0; j--) {
      this.c[j] = z[j] - mu[j] * this.c[j + 1];
      this.b[j] = (this.a[j + 1] - this.a[j]) / h[j] - h[j] * (this.c[j + 1] + 2 * this.c[j]) / 3;
      this.d[j] = (this.c[j + 1] - this.c[j]) / (3 * h[j]);
    }
  }

  /**
   * 计算拟合值
   */
  evaluate(xVal: number): number {
    const n = this.x.length;
    
    // 边界处理
    if (xVal <= this.x[0]) {
      return this.y[0];
    }
    if (xVal >= this.x[n - 1]) {
      return this.y[n - 1];
    }

    // 找到区间
    let i = 0;
    for (let j = 0; j < n - 1; j++) {
      if (this.x[j] <= xVal && xVal <= this.x[j + 1]) {
        i = j;
        break;
      }
    }

    const dx = xVal - this.x[i];
    return this.a[i] + this.b[i] * dx + this.c[i] * dx * dx + this.d[i] * dx * dx * dx;
  }

  /**
   * 计算一阶导数
   */
  derivative(xVal: number): number {
    const n = this.x.length;
    
    // 边界处理
    if (xVal <= this.x[0]) {
      return this.b[0];
    }
    if (xVal >= this.x[n - 1]) {
      return this.b[n - 2] + 2 * this.c[n - 2] * (this.x[n - 1] - this.x[n - 2]) +
             3 * this.d[n - 2] * Math.pow(this.x[n - 1] - this.x[n - 2], 2);
    }

    // 找到区间
    let i = 0;
    for (let j = 0; j < n - 1; j++) {
      if (this.x[j] <= xVal && xVal <= this.x[j + 1]) {
        i = j;
        break;
      }
    }

    const dx = xVal - this.x[i];
    return this.b[i] + 2 * this.c[i] * dx + 3 * this.d[i] * dx * dx;
  }
}

/**
 * LOESS 局部加权回归
 */
export function loessFit(
  x: number[],
  y: number[],
  xNew: number[],
  span: number = 0.3,
  degree: number = 2
): number[] {
  const n = x.length;
  const q = Math.floor(span * n);
  const result: number[] = [];

  for (const xi of xNew) {
    // 计算距离并找到最近的 q 个点
    const distances = x.map((xj, idx) => ({
      idx,
      dist: Math.abs(xj - xi),
    }));
    distances.sort((a, b) => a.dist - b.dist);

    // 计算带宽
    const h = distances[q - 1].dist;

    // 计算权重（三立方核函数）
    const weights: number[] = new Array(n).fill(0);
    for (let i = 0; i < q; i++) {
      const idx = distances[i].idx;
      const u = distances[i].dist / (h + 1e-10);
      weights[idx] = u < 1 ? Math.pow(1 - Math.pow(u, 3), 3) : 0;
    }

    // 加权多项式拟合
    const wX: number[] = [];
    const wY: number[] = [];
    const w: number[] = [];

    for (let i = 0; i < n; i++) {
      if (weights[i] > 0) {
        wX.push(x[i]);
        wY.push(y[i]);
        w.push(weights[i]);
      }
    }

    if (wX.length < degree + 1) {
      result.push(y[Math.min(Math.floor(xi - x[0]) / (x[1] - x[0] + 1e-10), n - 1)]);
      continue;
    }

    // 加权最小二乘
    const coeffs = weightedPolynomialFit(wX, wY, w, degree);
    result.push(polynomialEvaluate(coeffs, xi));
  }

  return result;
}

/**
 * 加权多项式拟合
 */
function weightedPolynomialFit(
  x: number[],
  y: number[],
  weights: number[],
  degree: number
): number[] {
  const n = x.length;
  
  // 构建加权矩阵
  const X: number[][] = [];
  
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j <= degree; j++) {
      row.push(Math.pow(x[i], j));
    }
    X.push(row);
  }

  // W 是对角矩阵
  const WDiag = weights;
  
  // X^T * W * X
  const XTWX: number[][] = [];
  for (let i = 0; i <= degree; i++) {
    const row: number[] = [];
    for (let j = 0; j <= degree; j++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += X[k][i] * WDiag[k] * X[k][j];
      }
      row.push(sum);
    }
    XTWX.push(row);
  }

  // X^T * W * y
  const XTWy: number[] = [];
  for (let i = 0; i <= degree; i++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += X[k][i] * WDiag[k] * y[k];
    }
    XTWy.push(sum);
  }

  // 求解
  const XTWXInv = inverse(XTWX);
  return multiplyVector(XTWXInv, XTWy);
}

/**
 * 高斯过程回归（简化版）
 */
export class GaussianProcess {
  private x: number[];
  private y: number[];
  private alpha: number[];
  private lengthScale: number;
  private sigmaF: number;
  private sigmaN: number;

  constructor(x: number[], y: number[], lengthScale: number = 0.1, sigmaF: number = 1, sigmaN: number = 0.01) {
    this.x = x;
    this.y = y;
    this.lengthScale = lengthScale;
    this.sigmaF = sigmaF;
    this.sigmaN = sigmaN;
    const n = x.length;

    // 计算核矩阵
    const K: number[][] = [];
    for (let i = 0; i < n; i++) {
      const row: number[] = [];
      for (let j = 0; j < n; j++) {
        const k = this.kernel(x[i], x[j]);
        row.push(k + (i === j ? this.sigmaN * this.sigmaN : 0));
      }
      K.push(row);
    }

    // 计算 alpha = K^-1 * y
    const KInv = inverse(K);
    this.alpha = multiplyVector(KInv, y);
  }

  private kernel(x1: number, x2: number): number {
    const diff = x1 - x2;
    return this.sigmaF * this.sigmaF * Math.exp(-0.5 * diff * diff / (this.lengthScale * this.lengthScale));
  }

  private kernelDerivative(x1: number, x2: number): number {
    const diff = x1 - x2;
    const k = this.kernel(x1, x2);
    return -diff / (this.lengthScale * this.lengthScale) * k;
  }

  evaluate(xNew: number): number {
    const n = this.x.length;
    let result = 0;
    for (let i = 0; i < n; i++) {
      result += this.alpha[i] * this.kernel(xNew, this.x[i]);
    }
    return result;
  }

  derivative(xNew: number): number {
    const n = this.x.length;
    let result = 0;
    for (let i = 0; i < n; i++) {
      result += this.alpha[i] * this.kernelDerivative(xNew, this.x[i]);
    }
    return result;
  }
}

// ==================== 辅助函数 ====================

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

function multiplyVector(A: number[][], v: number[]): number[] {
  const rows = A.length;
  const cols = A[0].length;
  const result: number[] = [];
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    for (let j = 0; j < cols; j++) {
      sum += A[i][j] * v[j];
    }
    result.push(sum);
  }
  return result;
}

function inverse(matrix: number[][]): number[][] {
  const n = matrix.length;
  const augmented: number[][] = [];

  for (let i = 0; i < n; i++) {
    augmented.push([...matrix[i]]);
    for (let j = 0; j < n; j++) {
      augmented[i].push(i === j ? 1 : 0);
    }
  }

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
        maxRow = k;
      }
    }
    [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

    const pivot = augmented[i][i];
    if (Math.abs(pivot) < 1e-15) {
      // 如果主元接近零，使用正则化
      for (let j = 0; j < 2 * n; j++) {
        augmented[i][j] /= (pivot + 1e-10);
      }
    } else {
      for (let j = 0; j < 2 * n; j++) {
        augmented[i][j] /= pivot;
      }
    }

    for (let k = 0; k < n; k++) {
      if (k !== i) {
        const factor = augmented[k][i];
        for (let j = 0; j < 2 * n; j++) {
          augmented[k][j] -= factor * augmented[i][j];
        }
      }
    }
  }

  const result: number[][] = [];
  for (let i = 0; i < n; i++) {
    result.push(augmented[i].slice(n));
  }
  return result;
}
