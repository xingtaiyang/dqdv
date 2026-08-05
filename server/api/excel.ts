import { Router } from 'express';
import { spawn } from 'child_process';
import { resolve } from 'path';

const router = Router();

// Excel 导出 API
router.post('/export-excel', async (req, res) => {
  const data = req.body;
  
  if (!data.voltage || !data.capacity) {
    res.status(400).json({ error: '缺少必要的数据字段' });
    return;
  }
  
  // 检查是否有差分数据
  if (!data.differential) {
    res.status(400).json({ error: '请先计算差分数据' });
    return;
  }
  
  // 调用 Python 脚本生成 Excel
  const pythonScript = resolve(process.cwd(), 'scripts/excel_generator.py');
  const jsonData = JSON.stringify(data);
  
  console.log('Starting Excel generation for:', data.name || '未命名数据集');
  
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
      res.status(500).json({ 
        error: 'Excel 生成失败', 
        details: errorOutput 
      });
      return;
    }
    
    const base64Data = output.trim();
    const filename = `${data.name || '数据集'}_${data.type === 'dqdv' ? 'dQ-dV' : 'dV-dQ'}_数据.xlsx`;
    
    console.log('Excel generated successfully:', filename);
    
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

export default router;
