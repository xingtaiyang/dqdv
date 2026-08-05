#!/usr/bin/env node
/* eslint-env node */
/**
 * 后端服务 - 处理 Excel 导出请求
 * 使用 Python xlsxwriter 创建带图表的 Excel 文件
 */

import express from 'express';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.EXCEL_SERVICE_PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'excel-export' });
});

// Excel 导出 API
app.post('/api/export-excel', (req, res) => {
  const data = req.body;
  
  if (!data.voltage || !data.capacity) {
    return res.status(400).json({ error: '缺少必要的数据字段' });
  }
  
  // 调用 Python 脚本生成 Excel
  const pythonScript = join(__dirname, 'scripts', 'excel_generator.py');
  const jsonData = JSON.stringify(data);
  
  const python = spawn('python3', [pythonScript, jsonData]);
  
  let output = '';
  let errorOutput = '';
  
  python.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  
  python.stderr.on('data', (chunk) => {
    errorOutput += chunk.toString();
  });
  
  python.on('close', (code) => {
    if (code !== 0) {
      console.error('Python script error:', errorOutput);
      return res.status(500).json({ 
        error: 'Excel 生成失败', 
        details: errorOutput 
      });
    }
    
    // 返回 base64 编码的 Excel 文件
    const base64Data = output.trim();
    
    // 设置响应头
    const filename = `${data.name || '数据集'}_${data.type === 'dqdv' ? 'dQ-dV' : 'dV-dQ'}_数据.xlsx`;
    res.json({
      success: true,
      filename: filename,
      data: base64Data,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  });
  
  python.on('error', (err) => {
    console.error('Failed to start Python process:', err);
    res.status(500).json({ 
      error: '无法启动 Excel 生成服务', 
      details: err.message 
    });
  });
});

// 启动服务
app.listen(PORT, () => {
  console.log(`Excel export service running on port ${PORT}`);
});
