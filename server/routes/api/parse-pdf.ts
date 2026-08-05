import { Request, Response } from 'express';
import { FetchClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';

export async function parsePdf(req: Request, res: Response) {
  try {
    // PDF文件的本地路径
    const pdfUrl = req.body.url || 'file:///workspace/projects/assets/Ko 等 - 2024 - Differential current in constant-voltage charging mode A novel tool for state-of-health and state-o.pdf';
    
    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);
    const config = new Config();
    const client = new FetchClient(config, customHeaders);

    const response = await client.fetch(pdfUrl);

    // 提取文本内容
    const textContent = response.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n');

    res.json({
      title: response.title,
      content: textContent,
      status: response.status_code
    });
  } catch (error) {
    console.error('PDF解析错误:', error);
    res.status(500).json({ error: 'PDF解析失败' });
  }
}
