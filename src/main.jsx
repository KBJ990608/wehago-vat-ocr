import { AlertCircle, Check, ChevronDown, Download, FileImage, FileSpreadsheet, LockKeyhole, Mail, RefreshCw, ShieldAlert, Upload, User, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Tesseract from 'tesseract.js';
import * as XLSX from 'xlsx';
import { fetchMonitoredLaws } from './lawApi';
import {
  LAW_REVIEWED_STORAGE_KEY,
  applyLawChangeGuard,
  approveCurrentLawSnapshot,
  compareLawSnapshots,
  getChangedLawImpacts,
  getRowLawImpacts,
  prepareLawSnapshots,
  readApprovedBaseline,
  splitChangedSentences,
} from './lawChangeMonitor';
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
  '일자': '일자',
  '거래처': '거래처',
  '구분': '구분',
  '품명': '품명',
  '공급가액': '공급가액',
  '세액': '세액',
  '비과세': '비과세',
  '합계': '합계',
  '국세청': '국세청',
  '업태': '업태',
  '종목': '종목',
  '유형': '유형',
  '차변계정': '차변계정',
  '대변계정': '대변계정',
  '전표상태': '전표상태',
  '판정': '판정',
  '신뢰도': '신뢰도',
  '근거조항': '근거조항',
  '근거키워드': '근거키워드',
  '주의': '주의',
  '법령근거': '법령근거',
  '법 기준 사유': '법 기준 사유',
};

const DECISION_LABELS = {
  '공제': '공제',
  '불공제': '불공제',
  '검토필요': '검토필요',
};

const AUTH_STORAGE_KEY = 'wehago-vat-auth-session';
const AUTH_USERS_STORAGE_KEY = 'wehago-vat-auth-users';
const APP_ENABLE_LOGIN = typeof __APP_ENABLE_LOGIN__ === 'boolean' ? __APP_ENABLE_LOGIN__ : false;
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
const FALLBACK_REVIEW_REASON = 'OCR 인식 정확도가 낮아 수동 검토가 필요합니다.';

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
  const keywordLine = judgement.근거키워드 ? `판정 근거 키워드: ${judgement.근거키워드}` : '';
  const warningLine = judgement.주의 ? `주의: ${judgement.주의}` : '';
  return [
    `[기본 법령 근거] ${judgement.근거조항 || '부가가치세법 제38조 및 제39조'}`,
    keywordLine,
    `판정: ${DECISION_LABELS[judgement.판정] || '검토필요'} · 신뢰도: ${judgement.신뢰도 || '-'}`,
    warningLine,
  ]
    .filter(Boolean)
    .join('\n');
}

function applyJudgement(row, articleReferences = {}, lawComparisons = []) {
  const judgement = applyLawChangeGuard(row, judgeVat(row, articleReferences), lawComparisons);
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

function readRegisteredUsers() {
  try {
    const users = JSON.parse(localStorage.getItem(AUTH_USERS_STORAGE_KEY) || '[]');
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function saveRegisteredUsers(users) {
  localStorage.setItem(AUTH_USERS_STORAGE_KEY, JSON.stringify(users));
}

function findRegisteredUser(email) {
  const normalizedEmail = normalizeText(email).toLowerCase();
  return readRegisteredUsers().find((user) => normalizeText(user.email).toLowerCase() === normalizedEmail);
}

function LoginScreen({ onLogin, onCancel, onSignup }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submitLogin(event) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    const registeredUser = findRegisteredUser(trimmedEmail);
    const isAdminLogin = trimmedEmail === APP_LOGIN_EMAIL && password === APP_LOGIN_PASSWORD;
    const isRegisteredLogin = registeredUser && registeredUser.password === password;

    if (isAdminLogin || isRegisteredLogin) {
      onLogin({
        email: trimmedEmail,
        name: registeredUser?.name || '관리자',
        signedInAt: new Date().toISOString(),
      });
      return;
    }
    setError('이메일 또는 비밀번호가 올바르지 않습니다.');
  }

  return (
    <main className="loginPage">
      <section className="authShell">
        <button type="button" className="authBrandButton" onClick={onCancel} title="홈으로">
          VATReview
        </button>
        <p className="authWelcome">WEHAGO 신용카드 매입세액 판정에 오신 것을 환영합니다</p>

      <form className="loginCard" onSubmit={submitLogin}>
        <div>
          <h1>로그인</h1>
        </div>
        <label>
          이메일
          <div className="authInput">
            <Mail size={22} />
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
          </div>
        </label>
        <label>
          비밀번호
          <div className="authInput">
            <LockKeyhole size={22} />
            <input
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError('');
              }}
              placeholder="비밀번호"
              type="password"
            />
          </div>
        </label>
        <button type="button" className="forgotButton" onClick={() => setError('비밀번호 재설정은 아직 연결되지 않았습니다.')}>
          비밀번호를 잊으셨나요?
        </button>
        {error ? <p className="loginError">{error}</p> : null}
        <button type="submit" className="primary loginButton">로그인</button>
        <p className="authSwitch">
          아직 계정이 없으신가요?
          <button type="button" onClick={onSignup}>회원가입</button>
        </p>
      </form>
      </section>
    </main>
  );
}

function SignupScreen({ onSignupComplete, onBack }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');

  function submitSignup(event) {
    event.preventDefault();
    const trimmedName = normalizeText(name);
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedName) {
      setError('이름을 입력하세요.');
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('올바른 이메일을 입력하세요.');
      return;
    }

    if (password.length < 6) {
      setError('비밀번호는 6자 이상 입력하세요.');
      return;
    }

    if (password !== passwordConfirm) {
      setError('비밀번호 확인이 일치하지 않습니다.');
      return;
    }

    if (trimmedEmail === APP_LOGIN_EMAIL.toLowerCase() || findRegisteredUser(trimmedEmail)) {
      setError('이미 가입된 이메일입니다.');
      return;
    }

    const nextUser = {
      id: crypto.randomUUID(),
      name: trimmedName,
      email: trimmedEmail,
      password,
      createdAt: new Date().toISOString(),
    };
    saveRegisteredUsers([...readRegisteredUsers(), nextUser]);
    onSignupComplete({
      email: nextUser.email,
      name: nextUser.name,
      signedInAt: new Date().toISOString(),
    });
  }

  return (
    <main className="loginPage">
      <form className="loginCard" onSubmit={submitSignup}>
        <div>
          <p className="eyebrow">WEHAGO 신용카드 매입</p>
          <h1>회원가입</h1>
        </div>
        <label>
          이름
          <div className="authInput">
            <User size={22} />
            <input
              autoComplete="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
              placeholder="홍길동"
              type="text"
            />
          </div>
        </label>
        <label>
          이메일
          <div className="authInput">
            <Mail size={22} />
            <input
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError('');
              }}
              placeholder="user@example.com"
              type="email"
            />
          </div>
        </label>
        <label>
          비밀번호
          <div className="authInput">
            <LockKeyhole size={22} />
            <input
              autoComplete="new-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError('');
              }}
              placeholder="6자 이상"
              type="password"
            />
          </div>
        </label>
        <label>
          비밀번호 확인
          <div className="authInput">
            <LockKeyhole size={22} />
            <input
              autoComplete="new-password"
              value={passwordConfirm}
              onChange={(event) => {
                setPasswordConfirm(event.target.value);
                setError('');
              }}
              placeholder="비밀번호 재입력"
              type="password"
            />
          </div>
        </label>
        {error ? <p className="loginError">{error}</p> : null}
        <button type="submit" className="primary loginButton">가입하고 시작</button>
        <button type="button" className="secondaryButton loginButton" onClick={onBack}>
          로그인으로 돌아가기
        </button>
        <small>
          현재 회원가입 정보는 이 브라우저에만 저장됩니다. 실제 서비스 배포 시에는 서버 인증으로 교체해야 합니다.
        </small>
      </form>
    </main>
  );
}

function buildBasisReason(row) {
  // 거래처(가맹점명)는 법령 검색어로 쓸모가 없고 외부 요청에 실려 나가므로 제외한다.
  return [
    row['판정'],
    row['근거키워드'],
    row['근거조항'],
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
      const source = result.target === 'law' ? '현행법령' : result.target === 'expc' ? '유권해석' : '판례';
      const date = result.date ? ` · ${result.date}` : '';
      const summary = result.summary ? `\n${result.summary.slice(0, 180)}${result.summary.length > 180 ? '...' : ''}` : '';
      return `[${source}] ${result.title || '제목 없음'}${date}${summary}`;
    })
    .join('\n\n');
}

function withLegalBasis(row, result) {
  const formattedBasis = formatLegalBasis(result.legalBasis);
  const nextReason = result.legalBasis.length
    ? `${row['법 기준 사유'] || ''}\n\n[관련 법령/유권해석/판례 검색 결과]\n${formattedBasis}`.trim()
    : `${row['법 기준 사유'] || ''}\n\n[관련 법령/유권해석/판례 검색 결과]\n법령근거: []`.trim();

  return {
    ...row,
    판정: result.errors.length ? '검토필요' : row['판정'],
    법령근거: result.legalBasis.length ? formattedBasis : row['법령근거'] || '[]',
    주의: result.errors.length
      ? '법령 검색 API 일부가 실패했습니다. 검토필요로 유지하고 원본 증빙을 확인하세요.'
      : row['주의'],
    '법 기준 사유': nextReason,
  };
}

function parseWorkbook(arrayBuffer, articleReferences = {}, lawComparisons = []) {
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
    .map((row) => applyJudgement(row, articleReferences, lawComparisons));
  return {
    rows: shapedRows,
    isResultExport,
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
      warning: 'OCR 인식 정확도가 낮아 최종 확인이 필요합니다.',
      판정: '검토필요',
      신뢰도: '30%',
      근거조항: '부가가치세법 제38조 및 제39조',
      근거키워드: '',
      주의: 'OCR 인식 정확도가 낮아 최종 확인이 필요합니다.',
      '법 기준 사유': `판정 근거 키워드: -\n신뢰도: 30%\n근거 조항: 부가가치세법 제38조 및 제39조\n주의: OCR 인식 정확도가 낮아 최종 확인이 필요합니다.\n${FALLBACK_REVIEW_REASON}`,
    };
    return {
      ...row,
      법령근거: buildDefaultLegalBasis(row, row),
    };
  });
}

function parseOcrText(text, articleReferences = {}, lawComparisons = []) {
  const candidates = text
    .split(/\r?\n/)
    .map(normalizeText)
    .filter((line) => line.length > 3)
    .filter((line) => !isSummaryText(line) && !isNumbersOnlyText(line))
    .filter((line) => hasMoney(line) || /공제|불공제|비공제/.test(line) || (hasKoreanWord(line) && hasMoney(line)))
    .map(mapOcrLineToRow)
    .filter(isValidRow)
    .map((row) => applyJudgement(row, articleReferences, lawComparisons));

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

function formatLawDate(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length !== 8) return value || '-';
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function formatCheckedAt(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function LawStatusPanel({
  lawState,
  rows,
  reviewed,
  approvalChecked,
  approvalText,
  onRefresh,
  onReview,
  onApprovalChecked,
  onApprovalText,
  onApprove,
}) {
  const changed = getChangedLawImpacts(lawState.comparisons);
  const unavailable = lawState.comparisons.filter((item) => item.status === 'unavailable');
  const canApproveSnapshot = lawState.snapshots.length === 4 && unavailable.length === 0;
  const tone = lawState.simulated ? 'simulation' : lawState.status;
  const title = lawState.status === 'loading'
    ? '최신 법령 확인 중'
    : lawState.status === 'changed'
      ? '세법 변경 감지'
      : lawState.status === 'unavailable'
        ? '최신 법령을 확인하지 못했습니다.'
        : '최신 법령 확인 완료';

  return (
    <section className={`lawStatusCard ${tone}`} aria-live="polite">
      <div className="lawStatusHeader">
        <div className="lawStatusTitle">
          {lawState.status === 'changed' || lawState.status === 'unavailable' ? <ShieldAlert size={22} /> : <Check size={22} />}
          <div>
            <span>법령 상태</span>
            <strong>{lawState.status === 'changed' ? `⚠ ${title}` : title}</strong>
          </div>
        </div>
        <button type="button" className="lawRefreshButton" onClick={onRefresh} disabled={lawState.status === 'loading'}>
          <RefreshCw className={lawState.status === 'loading' ? 'spin' : ''} size={16} />
          최신 법령 다시 확인
        </button>
      </div>

      {lawState.simulated ? <p className="simulationNotice">테스트용 법령 변경 시뮬레이션입니다.</p> : null}

      <div className="lawStatusSummary">
        <p>부가가치세법 제26조·제38조·제39조 및 시행령 제79조</p>
        {lawState.status === 'loading' ? <p>국가법령정보 API에서 현행 조문을 조회하고 있습니다.</p> : null}
        {lawState.status === 'unchanged' ? <p className="lawResult">변경 없음</p> : null}
        {lawState.status === 'changed' ? (
          <p>기준 조문과 현재 조문이 다릅니다. 관련 자동 판정이 검토필요로 전환되었습니다.</p>
        ) : null}
        {lawState.status === 'unavailable' ? (
          <p>기존 판정 규칙은 유지되며 실제 신고 전 최신 법령을 별도로 확인하세요.</p>
        ) : null}
        {lawState.checkedAt ? <small>마지막 확인: {formatCheckedAt(lawState.checkedAt)}</small> : null}
        {lawState.error ? <small className="lawError">{lawState.error}</small> : null}
      </div>

      {changed.length ? (
        <div className="changedLawList">
          {changed.map((comparison) => {
            const diff = splitChangedSentences(comparison.baseline?.normalizedContent, comparison.current?.normalizedContent);
            const relatedCount = rows.filter((row) => getRowLawImpacts(row, row, [comparison]).length).length;
            return (
              <details className="changedLawItem" key={comparison.key}>
                <summary>
                  <span>
                    <strong>{comparison.current?.articleLabel || `${comparison.baseline?.lawName} 제${comparison.baseline?.articleNumber}조`}</strong>
                    <small>상태: 검토 필요 · 관련 거래 {relatedCount}건</small>
                  </span>
                  <ChevronDown size={18} />
                </summary>
                <div className="lawDetailGrid">
                  <dl>
                    <div><dt>기준 시행일자</dt><dd>{formatLawDate(comparison.baseline?.enforcementDate)}</dd></div>
                    <div><dt>현재 시행일자</dt><dd>{formatLawDate(comparison.current?.enforcementDate)}</dd></div>
                    <div><dt>영향받는 규칙</dt><dd>{comparison.impact.rules.join(', ')}</dd></div>
                    <div><dt>관련 거래</dt><dd>{relatedCount}건</dd></div>
                  </dl>
                  <div className="lawTextColumns">
                    <div><strong>기준 조문</strong><pre>{comparison.baseline?.normalizedContent || '기준 조문 없음'}</pre></div>
                    <div><strong>현재 조문</strong><pre>{comparison.current?.normalizedContent || '현재 조문 없음'}</pre></div>
                  </div>
                  <div className="sentenceDiff">
                    <strong>간단 변경 비교</strong>
                    {comparison.dateChanged ? <p>시행일자가 변경되었습니다.</p> : null}
                    {diff.removed.length ? <p><b>기존에만 있음:</b> {diff.removed.join(' / ')}</p> : null}
                    {diff.added.length ? <p><b>현재에만 있음:</b> {diff.added.join(' / ')}</p> : null}
                    {!comparison.dateChanged && !diff.removed.length && !diff.added.length && comparison.simulated
                      ? <p>시뮬레이션을 위해 제39조가 변경된 상태로 비교되었습니다.</p>
                      : null}
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      ) : null}

      {unavailable.length && lawState.status !== 'loading' ? (
        <p className="unavailableArticles">조회하지 못한 조문: {unavailable.map((item) => item.baseline ? `${item.baseline.lawName} 제${item.baseline.articleNumber}조` : item.key).join(', ')}</p>
      ) : null}

      {changed.length ? (
        <div className="lawAdminPanel">
          <strong>관리자 검토 및 승인</strong>
          <p>기준 조문 갱신은 판정 규칙이 최신 세법과 일치하는지 검토한 후 진행해야 합니다. 기준 조문만 갱신하면 잘못된 자동 판정이 발생할 수 있습니다.</p>
          <div className="lawAdminActions">
            <button type="button" onClick={onReview} className="secondaryButton">{reviewed ? '변경 내용 확인 완료' : '변경 내용 확인'}</button>
            <label className="approvalCheck">
              <input type="checkbox" checked={approvalChecked} onChange={(event) => onApprovalChecked(event.target.checked)} />
              최신 조문과 관련 판정 규칙을 검토했습니다.
            </label>
            <input value={approvalText} onChange={(event) => onApprovalText(event.target.value)} placeholder="확인 문구 ‘승인’ 입력" aria-label="승인 확인 문구" />
            <button
              type="button"
              className="primary"
              onClick={onApprove}
              disabled={!approvalChecked || approvalText !== '승인' || lawState.simulated || !canApproveSnapshot}
              title={lawState.simulated
                ? '시뮬레이션에서는 실제 기준을 갱신할 수 없습니다.'
                : !canApproveSnapshot ? '모든 감시 대상 조문을 조회한 뒤 승인할 수 있습니다.' : ''}
            >
              검토 완료 및 기준 조문 갱신
            </button>
          </div>
        </div>
      ) : null}

    </section>
  );
}

function ChatBot() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([
    { type: 'bot', text: '안녕하세요! 매입세액 판정에 대해 궁금한 점이 있으신가요?' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setMessages(prev => [...prev, { type: 'user', text: userMessage }]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/rag/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: userMessage }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'RAG 응답 오류');
      }

      const sources = (data.hits || [])
        .slice(0, 3)
        .map(hit => `${hit.title} (${hit.date})`)
        .join('\n');
      const botResponse = sources
        ? `${data.answer}\n\n[관련 근거]\n${sources}`
        : data.answer;
      setMessages(prev => [...prev, { type: 'bot', text: botResponse }]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          type: 'bot',
          text: '세법 RAG 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="chatBot">
      <button
        className="chatBotToggle"
        onClick={() => setIsOpen(!isOpen)}
        title={isOpen ? '챗봇 닫기' : '챗봇 열기'}
      >
        <img src="/lumi-chatbot.png" alt="루미" />
      </button>

      {isOpen && (
        <div className="chatBotWindow">
          <div className="chatBotHeader">
            <strong>매입세액 판정 어시스턴트</strong>
            <button
              type="button"
              className="chatBotClose"
              onClick={() => setIsOpen(false)}
              title="닫기"
            >
              ×
            </button>
          </div>

          <div className="chatBotMessages">
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`chatMessage ${msg.type}`}
              >
                {msg.type === 'bot' && <img src="/lumi-chatbot.png" alt="루미" className="botAvatar" />}
                <div className="messageBubble">{msg.text}</div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="chatBotInput">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="질문을 입력하세요..."
              disabled={isLoading}
            />
            <button type="button" onClick={handleSend} title="전송" disabled={isLoading || !input.trim()}>
              {isLoading ? '…' : '→'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  const [session, setSession] = useState(readSavedSession);
  const [fileName, setFileName] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('업로드 대기');
  const [lawInfo, setLawInfo] = useState(null);
  const [lawState, setLawState] = useState({
    status: 'loading', comparisons: [], snapshots: [], checkedAt: '', error: '', simulated: false,
  });
  const [lawReviewed, setLawReviewed] = useState(() => localStorage.getItem(LAW_REVIEWED_STORAGE_KEY) === 'true');
  const [approvalChecked, setApprovalChecked] = useState(false);
  const [approvalText, setApprovalText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [legalBasisLoadingId, setLegalBasisLoadingId] = useState('');
  const [rowReports, setRowReports] = useState({});
  const [reportDraft, setReportDraft] = useState({ rowId: '', reason: '' });
  const [authView, setAuthView] = useState('app');
  const [decisionFilter, setDecisionFilter] = useState('');
  const excelInputRef = useRef(null);
  const ocrInputRef = useRef(null);
  const lawFetchStartedRef = useRef(false);
  const simulateLawChange = useMemo(() => new URLSearchParams(window.location.search).get('simulateLawChange') === '1', []);

  const summary = useMemo(() => {
    return RESULT_OPTIONS.reduce((acc, option) => {
      acc[option] = rows.filter((row) => normalizeDecision(row['판정']) === option).length;
      return acc;
    }, {});
  }, [rows]);

  const visibleRows = useMemo(() => {
    if (!decisionFilter) return rows;
    return rows.filter((row) => normalizeDecision(row['판정']) === decisionFilter);
  }, [decisionFilter, rows]);

  function rejudgeRows(currentRows, articleReferences, comparisons) {
    return currentRows.map((row) => {
      if (row._userModifiedDecision) return row;
      const judgement = applyLawChangeGuard(row, judgeVat(row, articleReferences), comparisons);
      return {
        ...row,
        ...judgement,
        법령근거: buildDefaultLegalBasis(row, judgement),
      };
    });
  }

  async function refreshMonitoredLaws() {
    setLawState((current) => ({ ...current, status: 'loading', error: '', simulated: simulateLawChange }));
    try {
      const lawData = await fetchMonitoredLaws();
      const snapshots = await prepareLawSnapshots(lawData.snapshots);
      const comparisons = compareLawSnapshots(readApprovedBaseline(), snapshots, { simulate: simulateLawChange });
      const hasChanges = comparisons.some((item) => item.status === 'changed');
      const hasUnavailable = comparisons.some((item) => item.status === 'unavailable' || item.status === 'not_monitored');
      const nextStatus = hasChanges ? 'changed' : hasUnavailable || lawData.errors.length ? 'unavailable' : 'unchanged';
      setLawInfo(lawData);
      setLawState({
        status: nextStatus,
        comparisons,
        snapshots,
        checkedAt: lawData.checkedAt,
        error: lawData.errors.join(' / '),
        simulated: simulateLawChange,
      });
      setRows((currentRows) => rejudgeRows(currentRows, lawData.articleReferences, comparisons));
    } catch (error) {
      setLawState({
        status: 'unavailable', comparisons: [], snapshots: [], checkedAt: new Date().toISOString(),
        error: error?.message || '법령 조회 실패', simulated: simulateLawChange,
      });
    }
  }

  useEffect(() => {
    if (APP_ENABLE_LOGIN && !session) return;
    if (lawFetchStartedRef.current) return;
    lawFetchStartedRef.current = true;
    refreshMonitoredLaws();
    // 페이지 진입 또는 로그인 직후 1회만 조회한다. 이후에는 사용자가 새로고침 버튼으로 요청한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  function markLawChangesReviewed() {
    localStorage.setItem(LAW_REVIEWED_STORAGE_KEY, 'true');
    setLawReviewed(true);
  }

  function approveLawBaseline() {
    if (
      !approvalChecked || approvalText !== '승인' || lawState.snapshots.length !== 4 || lawState.simulated
      || lawState.comparisons.some((item) => item.status === 'unavailable')
    ) return;
    const nextBaseline = approveCurrentLawSnapshot(lawState.snapshots);
    const comparisons = compareLawSnapshots(nextBaseline, lawState.snapshots);
    setLawState((current) => ({ ...current, status: 'unchanged', comparisons, simulated: false }));
    setRows((currentRows) => rejudgeRows(currentRows, lawInfo?.articleReferences ?? {}, comparisons));
    setLawReviewed(false);
    setApprovalChecked(false);
    setApprovalText('');
  }

  function handleLogin(nextSession) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextSession));
    setSession(nextSession);
    setAuthView('app');
  }

  function handleLogout() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    setSession(null);
    setAuthView('app');
    setFileName('');
    setImageUrl('');
    setRows([]);
    setRowReports({});
    setReportDraft({ rowId: '', reason: '' });
    setDecisionFilter('');
    setStatus('업로드 대기');
  }

  async function handleSpreadsheet(file) {
    if (!file) return;
    setFileName(file.name);
    setImageUrl('');
    setRows([]);
    setRowReports({});
    setReportDraft({ rowId: '', reason: '' });
    setDecisionFilter('');
    setStatus('파일 분석 중');
    setIsProcessing(true);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const parsed = parseWorkbook(arrayBuffer, lawInfo?.articleReferences ?? {}, lawState.comparisons);
      setRows(parsed.rows);
      setStatus(parsed.isResultExport ? '결과 파일 재업로드 감지' : '엑셀 분석 완료');
    } catch (error) {
      setStatus('파일 분석 실패');
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
    setRowReports({});
    setReportDraft({ rowId: '', reason: '' });
    setDecisionFilter('');
    setStatus('보조 OCR 실행 중');
    setIsProcessing(true);

    try {
      const processedImage = await preprocessImage(file);
      const result = await Tesseract.recognize(processedImage, 'kor+eng');
      const text = result.data.text;
      const parsedRows = parseOcrText(text, lawInfo?.articleReferences ?? {}, lawState.comparisons);
      setRows(parsedRows);
      setStatus(parsedRows.length ? `거래 후보 ${parsedRows.length}건 / 검토필요` : '거래 후보 0건');
    } catch (error) {
      setStatus('OCR 실패');
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
        if (column === '판정') return { ...nextRow, _userModifiedDecision: true, _lawGuard: null };
        if (!['판정', '신뢰도', '근거조항', '근거키워드', '주의', '법령근거', '법 기준 사유'].includes(column)) {
          if (nextRow._userModifiedDecision) return nextRow;
          const judgement = applyLawChangeGuard(
            nextRow,
            judgeVat(nextRow, lawInfo?.articleReferences ?? {}),
            lawState.comparisons,
          );
          return { ...nextRow, ...judgement, 법령근거: buildDefaultLegalBasis(nextRow, judgement) };
        }
        return nextRow;
      }),
    );
  }

  function openErrorReport(row) {
    setReportDraft({
      rowId: row.id,
      reason: rowReports[row.id]?.reason || '',
    });
  }

  function cancelErrorReport() {
    setReportDraft({ rowId: '', reason: '' });
  }

  function submitErrorReport(row) {
    const reason = normalizeText(reportDraft.reason);
    if (!reason) return;

    setRowReports((currentReports) => ({
      ...currentReports,
      [row.id]: {
        reason,
        decision: normalizeDecision(row['판정']),
        reportedAt: new Date().toISOString(),
      },
    }));
    setReportDraft({ rowId: '', reason: '' });
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
    XLSX.utils.book_append_sheet(workbook, worksheet, '매입세액 판정');
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
    XLSX.utils.book_append_sheet(workbook, worksheet, '업로드 예시');
    XLSX.writeFile(workbook, 'wehago-vat-upload-sample.xlsx');
  }

  async function showLegalBasis(row) {
    setLegalBasisLoadingId(row.id);
    const reason = buildBasisReason(row) || '부가가치세 매입세액 공제 불공제';

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
                주의: '법령 검색 API가 실패했습니다. 검토필요로 유지하고 원본 증빙을 확인하세요.',
                '법 기준 사유': `${currentRow['법 기준 사유'] || ''}\n\n법령근거: []\n${error?.message ?? error}`.trim(),
              }
            : currentRow,
        ),
      );
    } finally {
      setLegalBasisLoadingId('');
    }
  }

  if (APP_ENABLE_LOGIN && !session) {
    if (authView === 'signup') {
      return (
        <SignupScreen
          onSignupComplete={handleLogin}
          onBack={() => setAuthView('login')}
        />
      );
    }

    return <LoginScreen onLogin={handleLogin} onSignup={() => setAuthView('signup')} />;
  }

  if (!session && authView === 'login') {
    return (
      <LoginScreen
        onLogin={handleLogin}
        onSignup={() => setAuthView('signup')}
        onCancel={() => setAuthView('app')}
      />
    );
  }

  if (!session && authView === 'signup') {
    return (
      <SignupScreen
        onSignupComplete={handleLogin}
        onBack={() => setAuthView('login')}
      />
    );
  }

  return (
    <main className="app">
      <section className="topbar">
        <div>
          <p className="eyebrow">WEHAGO 신용카드 매입</p>
          <h1>신용카드 매입세액 판정기</h1>
        </div>
        <div className="actions">
          <button type="button" className="iconButton" onClick={() => excelInputRef.current?.click()} title="Excel/CSV 업로드">
            <Upload size={18} />
          </button>
          <button type="button" className="secondaryButton" onClick={downloadSampleExcel} title="예시 Excel 다운로드">
            <Download size={18} />
            예시 Excel
          </button>
          <button type="button" className="primary" onClick={downloadExcel} disabled={!rows.length} title="결과 Excel 다운로드">
            <Download size={18} />
            결과 Excel
          </button>
          {session ? (
            <button type="button" className="secondaryButton" onClick={handleLogout} title="로그아웃">
              로그아웃
            </button>
          ) : (
            <button type="button" className="secondaryButton" onClick={() => setAuthView('login')} title="로그인">
              로그인
            </button>
          )}
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

      <LawStatusPanel
        lawState={lawState}
        rows={rows}
        reviewed={lawReviewed}
        approvalChecked={approvalChecked}
        approvalText={approvalText}
        onRefresh={refreshMonitoredLaws}
        onReview={markLawChangesReviewed}
        onApprovalChecked={setApprovalChecked}
        onApprovalText={setApprovalText}
        onApprove={approveLawBaseline}
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
            <span>{fileName || 'Excel/CSV 파일 업로드'}</span>
            <small>.xlsx, .xls, .csv</small>
          </button>

          <div className="statusBox">
            <div className="statusHeader">
              {isProcessing ? <RefreshCw className="spin" size={18} /> : <FileSpreadsheet size={18} />}
              <strong>{status}</strong>
            </div>
            <span className="progressText">{isProcessing ? '파일 분석 중' : rows.length ? '분석 완료' : '업로드 대기'}</span>
          </div>

          <div className="summaryGrid">
            <div><Check size={16} /><span>공제</span><strong>{summary['공제'] || 0}</strong></div>
            <div><X size={16} /><span>불공제</span><strong>{summary['불공제'] || 0}</strong></div>
            <div><AlertCircle size={16} /><span>검토필요</span><strong>{summary['검토필요'] || 0}</strong></div>
          </div>

          <div className="secondaryUpload">
            <div>
              <strong>보조 OCR</strong>
              <span>스크린샷만 있을 때 사용</span>
            </div>
            <button type="button" onClick={() => ocrInputRef.current?.click()}>
              <FileImage size={16} />
              PNG/JPG
            </button>
            {imageUrl ? <img src={imageUrl} alt="업로드한 스크린샷 미리보기" /> : null}
          </div>

        </aside>

        <section className="tablePanel">
          <div className="tableToolbar">
            <div className="toolbarTitle">
              <strong>{visibleRows.length.toLocaleString()}건</strong>
              <span>{decisionFilter ? `${DECISION_LABELS[decisionFilter]} 표시` : '판정된 거래'}</span>
              <div className="toolbarSummary" aria-label="판정 요약">
                <span className="summaryPill deductible">공제 {summary['공제'] || 0}</span>
                <span className="summaryDivider">/</span>
                <span className="summaryPill nondeductible">불공제 {summary['불공제'] || 0}</span>
                <span className="summaryDivider">/</span>
                <span className="summaryPill review">검토필요 {summary['검토필요'] || 0}</span>
              </div>
              <label className="decisionFilter">
                <span>판정</span>
                <select
                  value={decisionFilter}
                  onChange={(event) => setDecisionFilter(event.target.value)}
                  aria-label="판정 필터"
                >
                  <option value="">전체</option>
                  {RESULT_OPTIONS.map((option) => (
                    <option key={option} value={option}>{DECISION_LABELS[option]}</option>
                  ))}
                </select>
              </label>
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
                {visibleRows.length ? visibleRows.map((row) => (
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
                      <div className="decisionCell">
                        {(() => {
                          const rowReport = rowReports[row.id];
                          const isReportOpen = reportDraft.rowId === row.id;
                          const canSubmitReport = isReportOpen && !!normalizeText(reportDraft.reason);

                          return (
                            <>
                        <select
                          className={`judgement ${normalizeDecision(row['판정'])}`}
                          value={normalizeDecision(row['판정'])}
                          onChange={(event) => updateCell(row.id, '판정', event.target.value)}
                        >
                          {RESULT_OPTIONS.map((option) => <option key={option} value={option}>{DECISION_LABELS[option]}</option>)}
                        </select>
                              <button
                                type="button"
                                className={`reportButton ${rowReport ? 'reported' : ''}`}
                                onClick={() => openErrorReport(row)}
                              >
                                {rowReport ? '신고 완료' : '오류 신고하기'}
                              </button>
                              {isReportOpen ? (
                                <div className="reportEditor">
                                  <textarea
                                    value={reportDraft.reason}
                                    onChange={(event) => setReportDraft({ rowId: row.id, reason: event.target.value })}
                                    placeholder="예) 전표가 ‘공제’로 판정되었지만, 접대비 항목이므로 ‘불공제’가 맞습니다."
                                  />
                                  <div className="reportActions">
                                    <button type="button" onClick={() => submitErrorReport(row)} disabled={!canSubmitReport}>
                                      제출
                                    </button>
                                    <button type="button" onClick={cancelErrorReport}>
                                      취소
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                              {rowReport && !isReportOpen ? (
                                <small className="reportReason" title={rowReport.reason}>
                                  사유: {rowReport.reason}
                                </small>
                              ) : null}
                            </>
                          );
                        })()}
                      </div>
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
                          title="관련 법령, 유권해석, 판례 검색"
                        >
                          {legalBasisLoadingId === row.id ? '조회 중' : '근거 조회'}
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
                      {rows.length && decisionFilter
                        ? `${DECISION_LABELS[decisionFilter]} 항목이 없습니다.`
                        : 'Excel 또는 CSV 파일을 업로드하면 신용카드 매입세액 판정 결과가 표시됩니다.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <ChatBot />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
