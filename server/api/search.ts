import express, { Request, Response } from 'express';
import { SearchClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  const { query, count, needSummary, timeRange, sites } = req.body;
  
  try {
    const customHeaders = HeaderUtils.extractForwardHeaders(
      req.headers as Record<string, string>
    );
    
    const config = new Config();
    const client = new SearchClient(config, customHeaders);
    
    const response = await client.advancedSearch(query, {
      count: count || 10,
      needSummary: needSummary ?? true,
      timeRange,
      sites,
    });
    
    res.json({
      summary: response.summary,
      results: response.web_items.map(item => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        siteName: item.site_name,
      })),
    });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: '搜索失败' });
  }
});

export default router;
