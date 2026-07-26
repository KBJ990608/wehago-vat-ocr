const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://localhost:5173';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-sol';

function extractResponseText(payload) {
  return Array.isArray(payload.output)
    ? payload.output
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .map((content) => content?.text || '')
        .join('')
        .trim()
    : '';
}

async function createOpenAIResponse(body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OpenAI API 키가 설정되지 않았습니다.');
    error.code = 'missing_api_key';
    throw error;
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: OPENAI_MODEL, ...body }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function askOpenAI(message) {
  const payload = await createOpenAIResponse({
    instructions:
      '당신은 WEHAGO 매입세액 판정 업무를 돕는 한국어 AI 도우미입니다. 핵심부터 간결하고 실무적으로 답하세요. 세무상 최종 판단이 필요한 경우 사실관계와 증빙을 확인하고 세무 전문가에게 검토받도록 분명히 안내하세요.',
    input: message,
    max_output_tokens: 700,
    reasoning: { effort: 'low' },
  });

  const reply = extractResponseText(payload);
  return {
    ok: true,
    reply: reply || '답변을 만들지 못했습니다. 질문을 조금 더 구체적으로 입력해 주세요.',
  };
}

function createMainWindow() {
  Menu.setApplicationMenu(null);

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'WEHAGO VAT OCR',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  } else {
    mainWindow.loadURL(DEV_SERVER_URL);
  }
}

ipcMain.handle('chatbot:ask', async (_event, payload = {}) => {
  const message = String(payload.message || '').trim();
  if (!message) {
    return { ok: false, code: 'empty_message', reply: '질문을 입력해 주세요.' };
  }

  try {
    return await askOpenAI(message);
  } catch (error) {
    console.error('OpenAI chatbot error', error);
    return {
      ok: false,
      code: 'openai_error',
      reply: 'OpenAI 연결에 문제가 생겼습니다. API 키, 결제 상태, 네트워크를 확인해 주세요.',
    };
  }
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
