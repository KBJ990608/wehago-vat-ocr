import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, Check, Download, FileImage, FileSpreadsheet, RefreshCw, Upload, X } from 'lucide-react';
import Tesseract from 'tesseract.js';
import * as XLSX from 'xlsx';
import { fetchVatAct } from './lawApi';
import { judgeVat, normalizeText } from './rules';
import { findVoucherLegalBasis } from './services/lawSearchService.ts';
import './styles.css';

const COLUMNS = [
  '일자',
  '거래처',
  '구분',
  '품명',
  '공급가액',
  '세액',
  '비과세',
  '합계',
  '국세청',
  '업태',
  '종목',
  '유형',
  '차변계정',
  '대변계정',
  '전표상태',
];

const RESULT_COLUMNS = [...COLUMNS, '판정', '신뢰도', '근거조항', '근거키워드', '주의', '법령근거', '법 기준 사유'];
const RESULT_OPTIONS = ['공제', '불공제', '검토필요'];

const LABELS = {
  '일자': 'Date',
  '거래처': 'Vendor',
  '구분': 'Tax Type',
  '품명': 'Item',
  '공급가액': 'Supply Amount',
  '세액': 'VAT',
  '비과세': 'Tax-free',
  '합계': 'Total',
  '국세청': 'NTS Status',
  '업태': 'Business Type',
  '종목': 'Business Item',
  '유형': 'Card Type',
  '차변계정': 'Debit Account',
  '대변계정': 'Credit Account',
  '전표상태': 'Voucher Status',
  '판정': 'Decision',
  '신뢰도': 'Confidence',
  '근거조항': 'Legal Clause',
  '근거키워드': 'Evidence Keywords',
  '주의': 'Warning',
  '법령근거': 'Legal Basis',
  '법 기준 사유': 'Reason',
};

const DECISION_LABELS = {
  '공제': 'Deductible',
  '불공제': 'Non-deductible',
  '검토필요': 'Needs review',
};

const AUTH_STORAGE_KEY = 'wehago-vat-auth-session';
const APP_LOGIN_EMAIL = typeof __APP_LOGIN_EMAIL__ === 'string' ? __APP_LOGIN_EMAIL__ : 'admin@example.com';
const APP_LOGIN_PASSWORD = typeof __APP_LOGIN_PASSWORD__ === 'string' ? __APP_LOGIN_PASSWORD__ : 'change-me';

const COLUMN_ALIASES = {
  '일자': ['일자', '거래일자', '사용일자', '승인일자', '매입일자', '날짜'],
  '거래처': ['거래처', '거래처명', '가맹점', '가맹점명', '상호', '사용처', '상호명'],
  '구분': ['구분', '과세구분', '매입구분'],
  '품명': ['품명', '적요', '내용', '상품명', '사용내역', '거래내용', '비고'],
  '공급가액': ['공급가액', '공급가', '과세표준', '공급금액', '공급대가'],
  '세액': ['세액', '부가세', '매입세액', '부가세액', '부가가치세', 'vat'],
  '비과세': ['비과세', '면세', '비과세금액', '면세금액'],
  '합계': ['합계', '총액', '총금액', '승인금액', '이용금액', '금액', '합계금액'],
  '국세청': ['국세청', '공제여부', '공제구분', '매입세액공제', '공제/불공제', '공제불공제', '불공제여부'],
  '업태': ['업태', '업종대분류'],
  '종목': ['종목', '업종', '업종명', '업종소분류'],
  '유형': ['유형', '카드유형', '카드구분'],
  '차변계정': ['차변계정', '차변계정과목', '차변계정명', '차변'],
  '대변계정': ['대변계정', '대변계정과목', '상대계정'],
  '전표상태': ['전표상태', '상태', '처리상태'],
};

const NUMERIC_COLUMNS = ['공급가액', '세액', '비과세', '합계'];
const FALLBACK_REVIEW_REASON = 'Low OCR confidence. Manual review is required.';

function canonicalHeader(value) {
  return normalizeText(value).replace(/[\s()[\]{}_\-/]/g, '').toLowerCase();
}

function fillMergedCells(worksheet) {
  const merges = worksheet['!merges'] ?? [];
  merges.forEach((merge) => {
    const sourceAddress = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    const sourceCell = worksheet[sourceAddress];
    if (!sourceCell) return;

    for (let row = merge.s.r; row <= merge.e.r; row += 1) {
      for (let column = merge.s.c; column <= merge.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        if (!worksheet[address]) worksheet[address] = { ...sourceCell };
      }
    }
  });
}

function normalizeAmount(value) {
  const cleaned = String(value ?? '').replace(/[^\d.-]/g, '');
  if (!cleaned || /^[-.]+$/.test(cleaned)) return '';
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : '';
}

function hasMoney(value) {
  return /\d{1,3}(,\d{3})+|\d{4,}/.test(String(value ?? ''));
}

function hasKoreanWord(value) {
  return /[가-힣]{2,}/.test(String(value ?? ''));
}

function isSummaryText(value) {
  return /카드사별|합계|합계\(카드사|매입\s*:|일반\s*:/.test(normalizeText(value));
}

function isNumbersOnlyText(value) {
  const text = normalizeText(value);
  return !!text && /^[\d\s,.-]+$/.test(text);
}

function isValidRow(row) {
  const rowText = COLUMNS.map((column) => normalizeText(row[column])).join(' ');
  if (!rowText || isSummaryText(rowText) || isNumbersOnlyText(rowText)) return false;

  const signals = [
    row['일자'],
    row['거래처'],
    row['품명'],
    row['국세청'],
    row['차변계정'],
    row['대변계정'],
    hasMoney(row['공급가액']) || hasMoney(row['세액']) || hasMoney(row['비과세']) || hasMoney(row['합계']) ? 'amount' : '',
  ].filter((value) => normalizeText(value)).length;

  return signals >= 2 || (hasKoreanWord(rowText) && hasMoney(rowText));
}

function detectHeaderRow(sheetRows) {
  let bestIndex = 0;
  let bestScore = -1;

  sheetRows.slice(0, 20).forEach((row, index) => {
    const previousRow = sheetRows[index - 1] ?? [];
    const cells = mergeHeaderRows(previousRow, row).map(canonicalHeader);
    const score = COLUMNS.reduce((total, column) => {
      const aliases = COLUMN_ALIASES[column].map(canonicalHeader);
      return total + (cells.some((cell) => matchesHeader(cell, aliases)) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function mergeHeaderRows(previousRow, row) {
  return row.map((cell, index) => {
    const current = normalizeText(cell);
    const previous = normalizeText(previousRow[index]);
    if (!previous || current.includes(previous)) return current;
    if (!current) return previous;
    return `${previous}${current}`;
  });
}

function matchesHeader(header, aliases) {
  if (!header) return false;
  return aliases.some((alias) => {
    if (!alias) return false;
    return header === alias || header.includes(alias) || alias.includes(header);
  });
}

function buildColumnMap(headers) {
  const normalizedHeaders = headers.map(canonicalHeader);

  return COLUMNS.reduce((map, column) => {
    const aliases = COLUMN_ALIASES[column].map(canonicalHeader);
    const index = normalizedHeaders.findIndex((header) => {
      if (column === '국세청' && /공급가액|합계|금액|세액|봉사료/.test(header)) {
        return false;
      }
      return matchesHeader(header, aliases);
    });
    if (index >= 0) map[column] = index;
    return map;
  }, {});
}

function shapeRow(rawRow, columnMap) {
  const shouldUsePositionFallback = Object.keys(columnMap).length < 4 && rawRow.length >= 8;

  return Object.fromEntries(
    COLUMNS.map((column) => {
      const index = shouldUsePositionFallback ? COLUMNS.indexOf(column) : columnMap[column];
      const value = index === undefined ? '' : rawRow[index];
      return [column, NUMERIC_COLUMNS.includes(column) ? normalizeAmount(value) : normalizeText(value)];
    }),
  );
}

function buildDefaultLegalBasis(row, judgement) {
  const keywordLine = judgement.근거키워드 ? `Evidence keywords: ${judgement.근거키워드}` : '';
  const warningLine = judgement.주의 ? `Warning: ${judgement.주의}` : '';
  return [
    `[Default legal basis] ${judgement.근거조항 || 'VAT Act Articles 38 and 39'}`,
    keywordLine,
    `Decision: ${DECISION_LABELS[judgement.판정] || 'Needs review'} · Confidence: ${judgement.신뢰도 || '-'}`,
    warningLine,
  ]
    .filter(Boolean)
    .join('\n');
}

function applyJudgement(row, articleReferences = {}) {
  const judgement = judgeVat(row, articleReferences);
  return {
    id: crypto.randomUUID(),
    ...row,
    ...judgement,
    법령근거: buildDefaultLegalBasis(row, judgement),
  };
}

function normalizeDecision(value) {
  return normalizeText(value).replace('비공제', '불공제');
}

function readSavedSession() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submitLogin(event) {
    event.preventDefault();
    if (email.trim() === APP_LOGIN_EMAIL && password === APP_LOGIN_PASSWORD) {
      onLogin({ email: email.trim(), signedInAt: new Date().toISOString() });
      return;
    }
    setError('Invalid email or password.');
  }

  return (
    <main className="loginPage">
      <form className="loginCard" onSubmit={submitLogin}>
        <div>
          <p className="eyebrow">WEHAGO Credit Card Purchases</p>
          <h1>Sign in</h1>
        </div>
        <label>
          Email
          <input
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError('');
            }}
            placeholder="admin@example.com"
            type="email"
          />
        </label>
        <label>
          Password
          <input
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError('');
            }}
            placeholder="Password"
            type="password"
          />
        </label>
        {error ? <p className="loginError">{error}</p> : null}
        <button type="submit" className="primary loginButton">Sign in</button>
        <small>
          Configure credentials with <code>APP_LOGIN_EMAIL</code> and <code>APP_LOGIN_PASSWORD</code>.
        </small>
      </form>
    </main>
  );
}

function buildBasisReason(row) {
  return [
    row['판정'],
    row['근거키워드'],
    row['근거조항'],
    row['거래처'],
    row['품명'],
    row['업태'],
    row['종목'],
    row['차변계정'],
    row['대변계정'],
    row['법 기준 사유'],
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function formatLegalBasis(results) {
  if (!results.length) return '[]';
  return results
    .map((result) => {
      const source = result.target === 'law' ? 'Current law' : result.target === 'expc' ? 'Interpretation' : 'Case law';
      const date = result.date ? ` · ${result.date}` : '';
      const summary = result.summary ? `\n${result.summary.slice(0, 180)}${result.summary.length > 180 ? '...' : ''}` : '';
      return `[${source}] ${result.title || 'Untitled'}${date}${summary}`;
    })
    .join('\n\n');
}

function withLegalBasis(row, result) {
  const formattedBasis = formatLegalBasis(result.legalBasis);
  const nextReason = result.legalBasis.length
    ? `${row['법 기준 사유'] || ''}\n\n[Related law / interpretation / case search results]\n${formattedBasis}`.trim()
    : `${row['법 기준 사유'] || ''}\n\n[Related law / interpretation / case search results]\nLegal basis: []`.trim();

  return {
    ...row,
    판정: result.errors.length ? '검토필요' : row['판정'],
    법령근거: result.legalBasis.length ? formattedBasis : row['법령근거'] || '[]',
    주의: result.errors.length
      ? 'Some legal search API calls failed. Keep as Needs review and check source evidence.'
      : row['주의'],
    '법 기준 사유': nextReason,
  };
}

function parseWorkbook(arrayBuffer, fileName, articleReferences = {}) {
  const workbook = XLSX.read(arrayBuffer, {
    type: 'array',
    raw: false,
    cellDates: true,
    codepage: 65001,
  });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  fillMergedCells(worksheet);
  const sheetRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
  const headerIndex = detectHeaderRow(sheetRows);
  const headers = mergeHeaderRows(sheetRows[headerIndex - 1] ?? [], sheetRows[headerIndex] ?? []);
  const isResultExport = RESULT_COLUMNS.every((column) => headers.includes(column));
  const columnMap = buildColumnMap(headers);
  const dataRows = sheetRows.slice(headerIndex + 1);
  const shapedRows = dataRows
    .map((row) => shapeRow(row, columnMap))
    .filter(isValidRow)
    .map((row) => applyJudgement(row, articleReferences));
  const previewRows = sheetRows.slice(0, 12).map((row) => row.map(normalizeText).join(' | ')).join('\n');
  const mappingPreview = Object.entries(columnMap)
    .map(([column, index]) => `${column} ← ${headers[index] || `${index + 1}번째 열`}`)
    .join('\n');

  return {
    rows: shapedRows,
    isResultExport,
    warning: isResultExport
      ? 'This file appears to be an exported result file. Upload the original WEHAGO/voucher Excel file for an accurate re-check.'
      : '',
    preview: `File: ${fileName}\nSheet: ${sheetName}\nHeader row: ${headerIndex + 1}\n\n${isResultExport ? '[Warning]\nThis looks like an exported result file from this app. Upload the original WEHAGO/voucher Excel file for an accurate re-check.\n\n' : ''}[Column mapping]\n${mappingPreview || 'Auto mapping failed. Falling back to default order.'}\n\n[Raw data preview]\n${previewRows}`,
  };
}

function splitOcrLine(line) {
  return normalizeText(line)
    .replace(/[|]/g, ' ')
    .split(/\s{2,}|\t+/)
    .map(normalizeText)
    .filter(Boolean);
}

function extractAmounts(line) {
  return normalizeText(line).match(/\d{1,3}(?:,\d{3})+|\d{4,}/g) ?? [];
}

function mapOcrLineToRow(line) {
  const cells = splitOcrLine(line);
  const amounts = extractAmounts(line);
  const date = line.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{2}[-./]\d{1,2}[-./]\d{1,2}/)?.[0] ?? '';
  const nts = line.match(/불공제|비공제|공제/)?.[0] ?? '';
  const koreanCells = cells.filter((cell) => hasKoreanWord(cell) && !/공제|불공제|비공제/.test(cell));

  return {
    ...Object.fromEntries(COLUMNS.map((column) => [column, ''])),
    '일자': date,
    '거래처': koreanCells[0] ?? '',
    '품명': koreanCells.slice(1, 3).join(' ') || line,
    '공급가액': normalizeAmount(amounts.at(-3)),
    '세액': normalizeAmount(amounts.at(-2)),
    '합계': normalizeAmount(amounts.at(-1)),
    '국세청': nts,
  };
}

function fallbackRowsFromText(text) {
  const rawLines = text
    .split(/\r?\n/)
    .map(normalizeText)
    .filter((line) => line.length > 3)
    .filter((line) => !isSummaryText(line) && !isNumbersOnlyText(line));
  const headerIndex = rawLines.findIndex((line) => /일자|거래처|품명|공급가액|국세청|차변/.test(line));
  const candidateLines = rawLines
    .slice(headerIndex >= 0 ? headerIndex + 1 : 0)
    .filter((line) => hasKoreanWord(line) || hasMoney(line) || /공제|불공제|비공제/.test(line))
    .slice(0, 3);

  return candidateLines.map((line) => {
    const row = {
      id: crypto.randomUUID(),
      ...mapOcrLineToRow(line),
      decision: '검토필요',
      confidence: 30,
      reason: FALLBACK_REVIEW_REASON,
      evidenceKeywords: [],
      warning: 'Low OCR confidence. Final confirmation is required.',
      판정: '검토필요',
      신뢰도: '30%',
      근거조항: 'VAT Act Articles 38 and 39',
      근거키워드: '',
      주의: 'Low OCR confidence. Final confirmation is required.',
      '법 기준 사유': `Evidence keywords: -\nConfidence: 30%\nLegal clause: VAT Act Articles 38 and 39\nWarning: Low OCR confidence. Final confirmation is required.\n${FALLBACK_REVIEW_REASON}`,
    };
    return {
      ...row,
      법령근거: buildDefaultLegalBasis(row, row),
    };
  });
}

function parseOcrText(text, articleReferences = {}) {
  const candidates = text
    .split(/\r?\n/)
    .map(normalizeText)
    .filter((line) => line.length > 3)
    .filter((line) => !isSummaryText(line) && !isNumbersOnlyText(line))
    .filter((line) => hasMoney(line) || /공제|불공제|비공제/.test(line) || (hasKoreanWord(line) && hasMoney(line)))
    .map(mapOcrLineToRow)
    .filter(isValidRow)
    .map((row) => applyJudgement(row, articleReferences));

  return candidates.length ? candidates : fallbackRowsFromText(text);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = URL.createObjectURL(file);
  });
}

async function preprocessImage(file) {
  const image = await loadImage(file);
  const scale = 2.8;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const contrast = 1.45;
  for (let index = 0; index < imageData.data.length; index += 4) {
    const gray = imageData.data[index] * 0.299 + imageData.data[index + 1] * 0.587 + imageData.data[index + 2] * 0.114;
    const value = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
    imageData.data[index] = value;
    imageData.data[index + 1] = value;
    imageData.data[index + 2] = value;
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

function App() {
  const [session, setSession] = useState(readSavedSession);
  const [fileName, setFileName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [rows, setRows] = useState([]);
  const [previewText, setPreviewText] = useState('');
  const [status, setStatus] = useState('Waiting');
  const [lawStatus, setLawStatus] = useState('Checking VAT Act');
  const [ruleStatus, setRuleStatus] = useState('Rule engine ready');
  const [lawInfo, setLawInfo] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [legalBasisLoadingId, setLegalBasisLoadingId] = useState('');
  const [bulkBasisStatus, setBulkBasisStatus] = useState('');
  const excelInputRef = useRef(null);
  const ocrInputRef = useRef(null);

  const summary = useMemo(() => {
    return RESULT_OPTIONS.reduce((acc, option) => {
      acc[option] = rows.filter((row) => normalizeDecision(row['판정']) === option).length;
      return acc;
    }, {});
  }, [rows]);

  useEffect(() => {
    if (!session) return undefined;
    let cancelled = false;

    async function loadVatAct() {
      try {
        const vatAct = await fetchVatAct();
        if (cancelled) return;
        setLawInfo(vatAct);
        setLawStatus(`${vatAct.title || 'VAT Act'} text connected · Articles 26/38/39 checked`);
        setRows((currentRows) =>
          currentRows.map(({ id, 사유, decision, confidence, reason, evidenceKeywords, warning, legalBasis, 판정, 신뢰도, 근거조항, 근거키워드, 주의, 법령근거, '법 기준 사유': legalReason, ...baseRow }) => {
            const judgement = judgeVat(baseRow, vatAct.articleReferences);
            return {
              id,
              ...baseRow,
              ...judgement,
              법령근거: 법령근거 && 법령근거 !== '[]' ? 법령근거 : buildDefaultLegalBasis(baseRow, judgement),
            };
          }),
        );
      } catch (error) {
        if (cancelled) return;
        setLawStatus(`Law text connection failed: ${error?.message ?? error} · default clauses are still shown`);
      }
    }

    loadVatAct();

    return () => {
      cancelled = true;
    };
  }, [session]);

  function handleLogin(nextSession) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
  }

  function handleLogout() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setSession(null);
    setFileName('');
    setImageUrl('');
    setRows([]);
    setPreviewText('');
    setStatus('Waiting');
    setRuleStatus('Rule engine ready');
  }

  async function handleSpreadsheet(file) {
    if (!file) return;
    setFileName(file.name);
    setImageUrl('');
    setRows([]);
    setPreviewText('');
    setStatus('Analyzing file');
    setRuleStatus('Applying rules');
    setIsProcessing(true);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const parsed = parseWorkbook(arrayBuffer, file.name, lawInfo?.articleReferences ?? {});
      setRows(parsed.rows);
      setPreviewText(parsed.preview);
      setStatus(parsed.isResultExport ? 'Result file re-upload detected' : 'Excel analysis complete');
      setRuleStatus(`Rules applied · ${parsed.rows.length.toLocaleString()} rows`);
    } catch (error) {
      setStatus('File analysis failed');
      setRuleStatus('Rule application failed');
      setPreviewText(String(error?.message ?? error));
      console.error(error);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleOcrImage(file) {
    if (!file || !/^image\/(png|jpe?g)$/i.test(file.type)) return;
    setFileName(file.name);
    setImageUrl(URL.createObjectURL(file));
    setRows([]);
    setPreviewText('');
    setStatus('Auxiliary OCR running');
    setRuleStatus('Applying rules');
    setIsProcessing(true);

    try {
      const processedImage = await preprocessImage(file);
      const result = await Tesseract.recognize(processedImage, 'kor+eng');
      const text = result.data.text;
      const parsedRows = parseOcrText(text, lawInfo?.articleReferences ?? {});
      setPreviewText(text);
      setRows(parsedRows);
      setStatus(parsedRows.length ? `OCR candidates: ${parsedRows.length} / Needs review` : 'OCR candidates: 0');
      setRuleStatus(`Rules applied · ${parsedRows.length.toLocaleString()} rows`);
    } catch (error) {
      setStatus('OCR failed');
      setRuleStatus('Rule application failed');
      setPreviewText(String(error?.message ?? error));
      console.error(error);
    } finally {
      setIsProcessing(false);
    }
  }

  function updateCell(id, column, value) {
    setRows((currentRows) =>
      currentRows.map((row) => {
        if (row.id !== id) return row;
        const nextRow = { ...row, [column]: NUMERIC_COLUMNS.includes(column) ? normalizeAmount(value) : value };
        if (!['판정', '신뢰도', '근거조항', '근거키워드', '주의', '법령근거', '법 기준 사유'].includes(column)) {
          const judgement = judgeVat(nextRow, lawInfo?.articleReferences ?? {});
          return { ...nextRow, ...judgement, 법령근거: buildDefaultLegalBasis(nextRow, judgement) };
        }
        return nextRow;
      }),
    );
  }

  function addEmptyRow() {
    const base = Object.fromEntries(COLUMNS.map((column) => [column, '']));
    setRows((currentRows) => [...currentRows, applyJudgement(base, lawInfo?.articleReferences ?? {})]);
  }

  function downloadExcel() {
    const data = rows.map(({ id, 사유, decision, confidence, reason, evidenceKeywords, warning, legalBasis, ...row }) =>
      Object.fromEntries(
        RESULT_COLUMNS.map((column) => [
          LABELS[column] || column,
          column === '판정' ? DECISION_LABELS[normalizeDecision(row[column])] || row[column] : row[column],
        ]),
      ),
    );
    const worksheet = XLSX.utils.json_to_sheet(data, { header: RESULT_COLUMNS.map((column) => LABELS[column] || column) });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'VAT Decision');
    XLSX.writeFile(workbook, `wehago-vat-result-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function downloadSampleExcel() {
    const sampleRows = [
      {
        '일자': '2026-01-05',
        '거래처': '욕지수산',
        '구분': '면세',
        '품명': '쌀',
        '공급가액': 32800,
        '세액': 0,
        '비과세': 32800,
        '합계': 32800,
        '국세청': '',
        '업태': '도소매',
        '종목': '농수산물',
        '유형': '일반',
        '차변계정': '상품',
        '대변계정': '미지급금',
        '전표상태': '전표확정',
      },
      {
        '일자': '2026-01-06',
        '거래처': '대한택배',
        '구분': '과세',
        '품명': '택배비',
        '공급가액': 10000,
        '세액': 1000,
        '비과세': 0,
        '합계': 11000,
        '국세청': '공제',
        '업태': '운수업',
        '종목': '택배',
        '유형': '일반',
        '차변계정': '운반비',
        '대변계정': '미지급금',
        '전표상태': '전표확정',
      },
      {
        '일자': '2026-01-07',
        '거래처': '서울꽃화원',
        '구분': '면세',
        '품명': '화환',
        '공급가액': 70000,
        '세액': 0,
        '비과세': 70000,
        '합계': 70000,
        '국세청': '',
        '업태': '도소매',
        '종목': '화훼',
        '유형': '일반',
        '차변계정': '접대비',
        '대변계정': '카드미지급금',
        '전표상태': '전표확정',
      },
      {
        '일자': '2026-01-08',
        '거래처': '행복주유소',
        '구분': '과세',
        '품명': '주유',
        '공급가액': 50000,
        '세액': 5000,
        '비과세': 0,
        '합계': 55000,
        '국세청': '',
        '업태': '소매',
        '종목': '주유소',
        '유형': '일반',
        '차변계정': '차량유지비',
        '대변계정': '카드미지급금',
        '전표상태': '전표확정',
      },
    ];
    const worksheet = XLSX.utils.json_to_sheet(sampleRows, { header: COLUMNS });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Upload Sample');
    XLSX.writeFile(workbook, 'wehago-vat-upload-sample.xlsx');
  }

  async function showLegalBasis(row) {
    setLegalBasisLoadingId(row.id);
    const reason = buildBasisReason(row) || 'VAT input tax deduction non-deduction';

    try {
      const result = await findVoucherLegalBasis(reason);
      setRows((currentRows) =>
        currentRows.map((currentRow) =>
          currentRow.id === row.id ? withLegalBasis(currentRow, result) : currentRow,
        ),
      );
    } catch (error) {
      setRows((currentRows) =>
        currentRows.map((currentRow) =>
          currentRow.id === row.id
            ? {
                ...currentRow,
                판정: '검토필요',
                법령근거: '[]',
                주의: 'Legal search API failed. Keep as Needs review and check source evidence.',
                '법 기준 사유': `${currentRow['법 기준 사유'] || ''}\n\nLegal basis: []\n${error?.message ?? error}`.trim(),
              }
            : currentRow,
        ),
      );
    } finally {
      setLegalBasisLoadingId('');
    }
  }

  async function showAllLegalBasis() {
    if (!rows.length || bulkBasisStatus) return;

    setBulkBasisStatus('Preparing bulk legal search');
    const cache = new Map();
    const nextRows = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const reason = buildBasisReason(row) || 'VAT input tax deduction non-deduction';
      const cacheKey = [
        normalizeDecision(row['판정']),
        row['근거조항'],
        row['근거키워드'],
        row['품명'],
        row['업태'],
        row['종목'],
        row['차변계정'],
      ]
        .map(normalizeText)
        .join('|');

      setBulkBasisStatus(`Searching legal basis ${index + 1}/${rows.length}`);

      try {
        if (!cache.has(cacheKey)) {
          cache.set(cacheKey, await findVoucherLegalBasis(reason));
        }
        nextRows.push(withLegalBasis(row, cache.get(cacheKey)));
      } catch (error) {
        nextRows.push({
          ...row,
          판정: '검토필요',
          법령근거: '[]',
          주의: 'Legal search API failed. Keep as Needs review and check source evidence.',
          '법 기준 사유': `${row['법 기준 사유'] || ''}\n\nLegal basis: []\n${error?.message ?? error}`.trim(),
        });
      }
    }

    setRows(nextRows);
    setBulkBasisStatus('');
  }

  if (!session) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <main className="app">
      <section className="topbar">
        <div>
          <p className="eyebrow">WEHAGO Credit Card Purchases</p>
          <h1>Input VAT Deduction Review</h1>
        </div>
        <div className="actions">
          <button type="button" className="iconButton" onClick={() => excelInputRef.current?.click()} title="Upload Excel/CSV">
            <Upload size={18} />
          </button>
          <button type="button" className="secondaryButton" onClick={downloadSampleExcel} title="Download sample Excel">
            <Download size={18} />
            Sample Excel
          </button>
          <button type="button" className="primary" onClick={downloadExcel} disabled={!rows.length} title="Download result Excel">
            <Download size={18} />
            Result Excel
          </button>
          <button type="button" className="secondaryButton" onClick={handleLogout} title="Sign out">
            Sign out
          </button>
        </div>
      </section>

      <input
        ref={excelInputRef}
        className="hiddenInput"
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={(event) => handleSpreadsheet(event.target.files?.[0])}
      />
      <input
        ref={ocrInputRef}
        className="hiddenInput"
        type="file"
        accept="image/png,image/jpeg"
        onChange={(event) => handleOcrImage(event.target.files?.[0])}
      />

      <section className="workspace">
        <aside className="uploadPanel">
          <button
            type="button"
            className="dropzone"
            onClick={() => excelInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              handleSpreadsheet(event.dataTransfer.files?.[0]);
            }}
          >
            <FileSpreadsheet size={44} />
            <span>{fileName || 'Upload Excel/CSV file'}</span>
            <small>.xlsx, .xls, .csv</small>
          </button>

          <div className="statusBox">
            <div className="statusHeader">
              {isProcessing ? <RefreshCw className="spin" size={18} /> : <FileSpreadsheet size={18} />}
              <strong>{status}</strong>
            </div>
            <span className="progressText">{isProcessing ? 'Analyzing file' : rows.length ? 'Analysis complete' : 'Waiting for upload'}</span>
          </div>

          <div className="summaryGrid">
            <div><Check size={16} /><span>Deductible</span><strong>{summary['공제'] || 0}</strong></div>
            <div><X size={16} /><span>Non-deductible</span><strong>{summary['불공제'] || 0}</strong></div>
            <div><AlertCircle size={16} /><span>Needs review</span><strong>{summary['검토필요'] || 0}</strong></div>
          </div>

          <div className="lawStatus">
            <strong>Legal Basis</strong>
            <span>{lawStatus}</span>
            {lawInfo ? (
              <>
                <small>
                  Reference law: {lawInfo.title || 'VAT Act'}
                  <br />
                  Law ID {lawInfo.lawId || '-'} · Serial No. {lawInfo.mst || '-'}
                  <br />
                  Effective date {lawInfo.enforcementDate || '-'} · Promulgation date {lawInfo.promulgationDate || '-'}
                  <br />
                  Ministry {lawInfo.ministry || '-'}
                  <br />
                  Checked articles {Object.values(lawInfo.articleReferences ?? {}).map((article) => article.label).join(', ') || '-'}
                </small>
                <p>
                  The app searches for the VAT Act, loads the selected law text, and uses it only to show supporting
                  legal clauses. The actual decision is still made by the rule engine.
                </p>
              </>
            ) : null}
          </div>

          <div className="ruleStatus">
            <strong>Rule Engine</strong>
            <span>{ruleStatus}</span>
            <p>
              Deductible, non-deductible, and needs-review decisions are made by keyword-based rules. The rules keep
              working even if the legal text API fails.
            </p>
          </div>

          <div className="secondaryUpload">
            <div>
              <strong>Auxiliary OCR</strong>
              <span>Use only when you have a screenshot</span>
            </div>
            <button type="button" onClick={() => ocrInputRef.current?.click()}>
              <FileImage size={16} />
              PNG/JPG
            </button>
            {imageUrl ? <img src={imageUrl} alt="Uploaded screenshot preview" /> : null}
          </div>

          <details className="ocrText">
            <summary>Raw Data Preview</summary>
            <pre>
              {previewText || 'After upload, part of the raw data will appear here.'}
              {lawInfo ? `\n\n[Legal API]\nReference law: ${lawInfo.title}\nLaw ID: ${lawInfo.lawId || '-'}\nSerial No.: ${lawInfo.mst || '-'}\nEffective date: ${lawInfo.enforcementDate || '-'}\nPromulgation date: ${lawInfo.promulgationDate || '-'}\nMinistry: ${lawInfo.ministry || '-'}` : ''}
            </pre>
          </details>
        </aside>

        <section className="tablePanel">
          <div className="tableToolbar">
            <div>
              <strong>{rows.length.toLocaleString()} rows</strong>
              <span>reviewed transactions</span>
              {bulkBasisStatus ? <span>{bulkBasisStatus}</span> : null}
            </div>
            <div className="toolbarActions">
              <button type="button" onClick={showAllLegalBasis} disabled={!rows.length || !!bulkBasisStatus}>
                {bulkBasisStatus ? 'Searching' : 'Search all legal basis'}
              </button>
              <button type="button" onClick={addEmptyRow}>Add row</button>
            </div>
          </div>

          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  {RESULT_COLUMNS.map((column) => <th key={column}>{LABELS[column] || column}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((row) => (
                  <tr key={row.id}>
                    {COLUMNS.map((column) => (
                      <td key={column}>
                        <input
                          value={row[column] ?? ''}
                          onChange={(event) => updateCell(row.id, column, event.target.value)}
                        />
                      </td>
                    ))}
                    <td>
                      <select
                        className={`judgement ${normalizeDecision(row['판정'])}`}
                        value={normalizeDecision(row['판정'])}
                        onChange={(event) => updateCell(row.id, '판정', event.target.value)}
                      >
                        {RESULT_OPTIONS.map((option) => <option key={option} value={option}>{DECISION_LABELS[option]}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        value={row['신뢰도'] ?? ''}
                        onChange={(event) => updateCell(row.id, '신뢰도', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        value={row['근거조항'] ?? ''}
                        onChange={(event) => updateCell(row.id, '근거조항', event.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        value={row['근거키워드'] ?? ''}
                        onChange={(event) => updateCell(row.id, '근거키워드', event.target.value)}
                      />
                    </td>
                    <td>
                      <textarea
                        value={row['주의'] ?? ''}
                        onChange={(event) => updateCell(row.id, '주의', event.target.value)}
                      />
                    </td>
                    <td>
                      <div className="basisCell">
                        <button
                          type="button"
                          className="miniButton"
                          onClick={() => showLegalBasis(row)}
                          disabled={legalBasisLoadingId === row.id}
                          title="Search related laws, interpretations, and cases"
                        >
                          {legalBasisLoadingId === row.id ? 'Searching' : 'Search more'}
                        </button>
                        <textarea
                          value={row['법령근거'] ?? '[]'}
                          onChange={(event) => updateCell(row.id, '법령근거', event.target.value)}
                        />
                      </div>
                    </td>
                    <td>
                      <textarea
                        value={row['법 기준 사유'] ?? row['사유'] ?? ''}
                        onChange={(event) => updateCell(row.id, '법 기준 사유', event.target.value)}
                      />
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td className="emptyState" colSpan={RESULT_COLUMNS.length}>
                      Upload an Excel or CSV file to see input VAT deduction results.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
