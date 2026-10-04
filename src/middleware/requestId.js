const { randomUUID } = require('crypto');

function requestId(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function extractionLifecycle(req, res, next) {
  const start = Date.now();
  const fields = () => ({
    request_id: req.requestId,
    route: '/api/extract',
    file_count: req.files?.length || 0,
    page_count: req.scanCount ?? null,
  });
  console.log('[extract] request started', JSON.stringify(fields()));
  res.on('finish', () => {
    console.log(res.statusCode >= 400 ? '[extract] request failed' : '[extract] request completed', JSON.stringify({
      ...fields(),
      success_count: req.extractionOutcome?.successCount || 0,
      failure_count: req.extractionOutcome?.failureCount ?? (req.files?.length || 0),
      duration_ms: Date.now() - start,
      error_code: res.statusCode >= 400 ? `HTTP_${res.statusCode}` : (req.extractionOutcome?.errorCode || null),
    }));
  });
  next();
}

module.exports = { requestId, extractionLifecycle };
