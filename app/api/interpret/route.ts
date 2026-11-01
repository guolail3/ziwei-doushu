import { NextRequest } from 'next/server';
import type { ZiweiChart } from '@/lib/ziwei/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

/** 把命盘序列化成 AI 可读的结构化文字 */
function chartToText(chart: ZiweiChart): string {
  const b = chart.birthInfo;
  const l = chart.lunarInfo;
  const lines: string[] = [];

  lines.push('【出生信息】');
  lines.push(`公历：${b.year}年${b.month}月${b.day}日 ${b.name ? '（' + b.name + '）' : ''}`);
  lines.push(`农历：${l.lunarYear}年${l.isLeapMonth ? '闰' : ''}${l.lunarMonth}月${l.lunarDay}日`);
  if (l.fourPillars) lines.push(`四柱：${l.fourPillars.join(' ')}`);
  lines.push(`性别：${b.gender === 'male' ? '男' : '女'}（${chart.yinYangGender ?? ''}）`);
  lines.push(`五行局：${chart.wuxingJuName}`);
  if (chart.mingZhu) lines.push(`命主：${chart.mingZhu}`);
  if (chart.shenZhu) lines.push(`身主：${chart.shenZhu}`);
  lines.push(`当前年龄：${chart.currentAge}岁`);

  lines.push('');
  lines.push('【十二宫】');
  for (const p of chart.palaces) {
    const stars = p.stars
      .filter(s => s.type === 'major' || s.type === 'minor')
      .map(s => s.name + (s.siHua ? `化${s.siHua}` : '') + (s.brightnessRaw ? `(${s.brightnessRaw})` : ''))
      .join('、') || '（空宫）';
    const tags: string[] = [];
    if (p.isMingGong) tags.push('命宫');
    if (p.isShenGong) tags.push('身宫');
    const selfSiHua = p.selfSihua?.map(m => `${m.starName}自化${m.siHua}`).join('、');
    const extra = [tags.length ? tags.join('') : '', selfSiHua ? `宫干自化：${selfSiHua}` : ''].filter(Boolean).join(' | ');
    lines.push(`【${p.name}】${stars}${extra ? '  ' + extra : ''}`);
  }

  lines.push('');
  lines.push('【大限】');
  chart.daXians.forEach((d, idx) => {
    const siHua = d.siHua ? ` 四化：禄-${d.siHua.lu} 权-${d.siHua.quan} 科-${d.siHua.ke} 忌-${d.siHua.ji}` : '';
    const isCurrent = idx === chart.currentDaXianIndex;
    lines.push(`${d.startAge}-${d.endAge}岁 → ${d.palaceName}${isCurrent ? '（当前大限）' : ''}${siHua}`);
  });

  return lines.join('\n');
}

/** 构造系统提示词，强调倪海厦《天纪》体系 */
function buildSystemPrompt(): string {
  return `你是精通紫微斗数的命理老师，严格遵循倪海厦《天纪》体系的解读口径。要求：
1. 语言简洁、结论先行，避免空话套话。
2. 引用星曜、四化、宫位时务必基于用户提供的命盘数据，不要编造盘里没有的星曜。
3. 每条结论尽量给出可操作的建议。
4. 用 Markdown 排版，重要标题用 **【标题】** 格式。
5. 措辞客观，不做绝对化的吉凶断言，可提示这是传统命理参考。`;
}

export async function POST(req: NextRequest) {
  const provider = process.env.AI_PROVIDER || 'deepseek';
  let apiKey = '';
  let baseUrl = 'https://api.deepseek.com/v1';
  let model = 'deepseek-chat';

  if (provider === 'deepseek') {
    apiKey = process.env.DEEPSEEK_API_KEY || '';
    baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  } else if (provider === 'mimo') {
    apiKey = process.env.MIMO_API_KEY || '';
    baseUrl = process.env.MIMO_BASE_URL || baseUrl;
    model = process.env.MIMO_MODEL || model;
  } else {
    apiKey = process.env.DEEPSEEK_API_KEY || '';
  }

  if (!apiKey) {
    return new Response(JSON.stringify({ error: '未配置 AI API Key，请在环境变量中设置 DEEPSEEK_API_KEY。' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: { chart?: ZiweiChart; messages?: { role: string; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: '请求体解析失败' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const chart = body.chart;
  const messages = body.messages || [];
  if (!chart) {
    return new Response(JSON.stringify({ error: '缺少 chart 数据' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const chartText = chartToText(chart);
  const systemContent = `${buildSystemPrompt()}\n\n以下是命盘数据：\n${chartText}`;

  // 组装对话：只保留最近的角色交替序列
  const chatMessages: { role: string; content: string }[] = [
    { role: 'system', content: systemContent },
    ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  ];

  // 如果最后一条不是 user，补一条空触发
  if (chatMessages[chatMessages.length - 1].role !== 'user') {
    chatMessages.push({ role: 'user', content: '请继续。' });
  }

  const upstream = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: chatMessages,
      stream: true,
      temperature: 0.7,
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return new Response(JSON.stringify({ error: `AI 服务调用失败(${upstream.status})：${errText.slice(0, 300)}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 建立 SSE 流，把上游 OpenAI 格式转成前端期望的 {delta:{text}} 格式
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                const out = JSON.stringify({ delta: { text: delta } });
                controller.enqueue(encoder.encode(`data: ${out}\n\n`));
              }
            } catch {
              // 忽略无法解析的行
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
