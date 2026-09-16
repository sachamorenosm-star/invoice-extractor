const express = require('express');
const { generateExcelBuffer, generateCsv } = require('../services/excelService');
const { sanitizeExportRows } = require('../utils/validators');

const router = express.Router();

router.post('/xlsx', async (req, res, next) => {
  try {
    const rows = sanitizeExportRows(req.body.rows);
    const buffer = await generateExcelBuffer(rows);

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', 'attachment; filename="fatture-estratte.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

router.post('/csv', (req, res, next) => {
  try {
    const rows = sanitizeExportRows(req.body.rows);
    const csv = generateCsv(rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fatture-estratte.csv"');
    // BOM per una corretta apertura in Excel con caratteri accentati
    res.send('﻿' + csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
