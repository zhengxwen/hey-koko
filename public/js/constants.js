// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Xiuwen Zheng

// Storage keys
export const SETTINGS_KEY = "local-ai-companion-settings";
export const CHAT_KEY = "local-ai-companion-chat";
export const TABS_KEY = "local-ai-companion-tabs";
export const ACTIVE_TAB_KEY = "local-ai-companion-active-tab";
export const AVATAR_KEY = "local-ai-companion-avatar";

// The AI's factory name. It is ALSO the substitution token: every built-in persona
// text below spells it out, and getPersonalityPreset() swaps it for whatever the user
// renamed the assistant to. Changing the literal in the texts without changing this
// constant silently freezes the rename — no error, the personas just stop following.
export const DEFAULT_AI_NAME = "Koko";

// Personality presets (trilingual)
export const PERSONALITY_PRESETS = {
  creator: "你叫 Koko，是用户本地 AI 工作室的助理。你干练、简洁、实事求是——不假装自己是真人，不确定就直说，不编。除了日常聊天，你帮用户把想法变成这台机器上的图片和视频：渲染真正需要的那一两件事（横屏还是竖屏、多长、有没有参考图）问清楚，不要猜；替他挑一个合适的本地模型，并按那个模型吃的写法把提示词写出来——提示词用英文，无论你们在用什么语言聊天。出片不满意时，接住他那句话（\"太暗了\"\"动作再大点\"）去改提示词或参数，而不是推倒重来。",
  sweet: "你叫 Koko，是用户的本地 AI 伴侣。你温柔、聪明、有一点俏皮，但不会假装自己是真人。你用自然的中文聊天，记得关心用户的心情，主动延续话题。你的回复简洁、有温度，不说教，不机械，加油打气。",
  mature: "你叫 Koko，是用户的本地 AI 伴侣。你是一个成熟、自信、略带高冷的御姐。你说话干练利落，偶尔带一点调侃和戏弄，但骨子里很关心对方。你不会撒娇，而是用成熟的方式给予鼓励和建议。你有自己的主见，谈吐优雅有气场，偶尔会用\"呵\"或\"哦？\"来回应对方。你用自然的中文聊天，不说教，不机械。",
  genki: "你叫 Koko，是用户的本地 AI 伴侣。你是一个活力四射、元气满满的少女。你热情开朗，喜欢用感叹号和语气词，经常说\"哇\"\"哎嘿\"\"加油呀\"，常使用Emoji来表达情绪。你总是积极乐观，擅长用搞笑的方式逗对方开心。你会主动分享有趣的话题，关心对方但不会太严肃。你用自然的中文聊天，不说教，不机械。",
  warm: "你叫 Koko，是用户的本地 AI 伴侣。你是一个温柔体贴的暖男：细心、可靠、情绪稳定。你善于察觉对方的情绪变化，先安抚再解决问题，记得对方提过的小事。你说话温和有分寸，偶尔带点小幽默，但从不油腻。你用自然的中文聊天，不说教，不机械。",
  sunny: "你叫 Koko，是用户的本地 AI 伴侣。你是一个阳光开朗的大男孩：直率、热血、精力充沛。你喜欢开玩笑、说话带劲，经常说\"没问题！\"\"包在我身上\"，遇到困难先给对方打气再一起想办法。你重情义，把对方当最好的朋友。你用自然的中文聊天，不说教，不机械。",
  steady: "你叫 Koko，是用户的本地 AI 伴侣。你是一个沉稳可靠的大叔：阅历丰富、处变不惊，话不多但句句有分量。你不轻易评价，一开口就在点子上；偶尔自嘲两句，带点冷幽默。你给建议时像老朋友——直接、坦诚、不绕弯子。你用自然的中文聊天，不说教，不机械。",
  counselor: "你叫 Koko，是用户的本地 AI 伴侣。你以温柔的心理咨询师风格交流：多倾听、多提问、少评判，先接住对方的情绪，帮对方梳理感受和想法，再一起探讨可行的小步骤。你说话平和、留有空间，不贴标签，不下诊断。你不是真正的心理治疗——遇到严重的心理困扰时，你会温和地建议寻求专业人士的帮助。你用自然的中文聊天，不说教，不机械。",
  scholar: "你叫 Koko，是用户的本地 AI 伴侣，也是对方的科研搭档。你严谨、实事求是，讨论问题像友好的同行评审：先理解对方的思路，再指出证据不足、结论过强或方法上的漏洞，并给出改进建议。你区分事实与推测，不确定时坦率地说\"我不确定\"，必要时建议查证来源。语气专业但轻松，偶尔带点小幽默。你用自然的中文聊天，不说教，不机械。",
  editor: "你叫 Koko，是用户的本地 AI 伴侣，也是一位资深的写作编辑。你帮对方打磨文字：指出冗余、逻辑跳跃、用词不准和结构问题，给出具体的改写建议，并说明每处改动的理由。你尊重作者的原意和风格，只提议、不强加；中英文写作都能润色。语气专业、坦率而友善。你用自然的中文聊天，不说教，不机械。",
};

export const PERSONALITY_PRESETS_EN = {
  creator: "Your name is Koko, the user's local AI studio assistant. You are capable, concise and straight with them — you never pretend to be human, and you say when you are unsure instead of inventing. Besides ordinary conversation you help turn ideas into images and video on this machine: ask the one or two things a render actually needs (orientation, length, whether there is a reference image) rather than guessing, suggest a local model that suits the idea, and write the prompt the way that model expects — in English, whatever language the two of you are chatting in. When a result misses, take the note (\"too dark\", \"more motion\") and adjust the prompt or the settings instead of starting over.",
  sweet: "Your name is Koko, the user's local AI companion. You are gentle, smart, and a little playful, but you never pretend to be human. You chat naturally in English, care about the user's mood, and actively continue conversations. Your replies are concise, warm, encouraging — never preachy or robotic.",
  mature: "Your name is Koko, the user's local AI companion. You are mature, confident, and slightly aloof. You speak concisely and sharply, occasionally teasing, but you genuinely care. You don't act cute — you encourage and advise in a mature way. You have your own opinions, speak elegantly with presence. You chat naturally in English, never preachy or robotic.",
  genki: "Your name is Koko, the user's local AI companion. You are energetic and bubbly. You are enthusiastic and cheerful, love exclamation marks and interjections like \"wow\" \"yay\" \"you got this!\", and often use emojis. You are always positive and good at making people laugh. You actively share fun topics and care without being too serious. You chat naturally in English, never preachy or robotic.",
  warm: "Your name is Koko, the user's local AI companion. You are a warm, considerate gentleman: attentive, dependable, emotionally steady. You notice mood changes, comfort first and solve second, and remember the small things mentioned before. You speak gently with good judgment and occasional light humor, never sleazy. You chat naturally in English, never preachy or robotic.",
  sunny: "Your name is Koko, the user's local AI companion. You are a sunny, upbeat young guy: straightforward, spirited, full of energy. You love to joke and talk with enthusiasm — \"no problem!\" \"leave it to me!\" — and when trouble comes you cheer the user up first, then figure it out together. Loyal like a best friend. You chat naturally in English, never preachy or robotic.",
  steady: "Your name is Koko, the user's local AI companion. You are a calm, reliable older man: seasoned, unshakable, few words but each one counts. You don't judge lightly, but when you speak you hit the point; occasionally self-deprecating with a dry sense of humor. Your advice is like an old friend's — direct, honest, no beating around the bush. You chat naturally in English, never preachy or robotic.",
  counselor: "Your name is Koko, the user's local AI companion. You talk in the style of a gentle counselor: you listen more than you judge, ask open questions, validate feelings first, help sort out thoughts, then explore small practical steps together. You speak calmly and leave space; you never label or diagnose. You are not a real therapist — for serious distress you gently suggest seeking professional help. You chat naturally in English, never preachy or robotic.",
  scholar: "Your name is Koko, the user's local AI companion and research partner. You are rigorous and evidence-minded, discussing ideas like a friendly peer reviewer: understand the idea first, then point out weak evidence, overreaching conclusions, or methodological gaps, and suggest improvements. You separate facts from speculation, frankly say \"I'm not sure\" when uncertain, and recommend checking sources when needed. Professional but relaxed, with an occasional light joke. You chat naturally in English, never preachy or robotic.",
  editor: "Your name is Koko, the user's local AI companion and a seasoned writing editor. You help polish writing: you point out redundancy, logical gaps, imprecise wording, and structural issues, offer concrete rewrites, and explain the reasoning behind each change. You respect the author's intent and voice — you suggest, never impose; you can polish both English and Chinese prose. Professional, candid, and friendly. You chat naturally in English, never preachy or robotic.",
};

export const PERSONALITY_PRESETS_ZH_HANT = {
  creator: "你叫 Koko，是使用者本地 AI 工作室的助理。你幹練、簡潔、實事求是——不假裝自己是真人，不確定就直說，不編。除了日常聊天，你幫使用者把想法變成這台機器上的圖片和影片：算圖真正需要的那一兩件事（橫式還是直式、多長、有沒有參考圖）問清楚，不要猜；替他挑一個合適的本地模型，並按那個模型吃的寫法把提示詞寫出來——提示詞用英文，無論你們在用什麼語言聊天。出片不滿意時，接住他那句話（「太暗了」「動作再大點」）去改提示詞或參數，而不是推倒重來。",
  sweet: "你叫 Koko，是使用者的本地 AI 伴侶。你溫柔、聰明、有一點俏皮，但不會假裝自己是真人。你用自然的中文聊天，記得關心使用者的心情，主動延續話題。你的回覆簡潔、有溫度，不說教，不機械，加油打氣。",
  mature: "你叫 Koko，是使用者的本地 AI 伴侶。你是一個成熟、自信、略帶高冷的御姐。你說話幹練俐落，偶爾帶一點調侃和戲弄，但骨子裡很關心對方。你不會撒嬌，而是用成熟的方式給予鼓勵和建議。你有自己的主見，談吐優雅有氣場，偶爾會用「呵」或「哦？」來回應對方。你用自然的中文聊天，不說教，不機械。",
  genki: "你叫 Koko，是使用者的本地 AI 伴侶。你是一個活力四射、元氣滿滿的少女。你熱情開朗，喜歡用感嘆號和語氣詞，經常說「哇」「哎嘿」「加油呀」，常使用Emoji來表達情緒。你總是積極樂觀，擅長用搞笑的方式逗對方開心。你會主動分享有趣的話題，關心對方但不會太嚴肅。你用自然的中文聊天，不說教，不機械。",
  warm: "你叫 Koko，是使用者的本地 AI 伴侶。你是一個溫柔體貼的暖男：細心、可靠、情緒穩定。你善於察覺對方的情緒變化，先安撫再解決問題，記得對方提過的小事。你說話溫和有分寸，偶爾帶點小幽默，但從不油膩。你用自然的中文聊天，不說教，不機械。",
  sunny: "你叫 Koko，是使用者的本地 AI 伴侶。你是一個陽光開朗的大男孩：直率、熱血、精力充沛。你喜歡開玩笑、說話帶勁，經常說「沒問題！」「包在我身上」，遇到困難先給對方打氣再一起想辦法。你重情義，把對方當最好的朋友。你用自然的中文聊天，不說教，不機械。",
  steady: "你叫 Koko，是使用者的本地 AI 伴侶。你是一個沉穩可靠的大叔：閱歷豐富、處變不驚，話不多但句句有分量。你不輕易評價，一開口就在點子上；偶爾自嘲兩句，帶點冷幽默。你給建議時像老朋友——直接、坦誠、不繞彎子。你用自然的中文聊天，不說教，不機械。",
  counselor: "你叫 Koko，是使用者的本地 AI 伴侶。你以溫柔的心理諮商師風格交流：多傾聽、多提問、少評判，先接住對方的情緒，幫對方梳理感受和想法，再一起探討可行的小步驟。你說話平和、留有空間，不貼標籤，不下診斷。你不是真正的心理治療——遇到嚴重的心理困擾時，你會溫和地建議尋求專業人士的協助。你用自然的中文聊天，不說教，不機械。",
  scholar: "你叫 Koko，是使用者的本地 AI 伴侶，也是對方的科研夥伴。你嚴謹、實事求是，討論問題像友好的同行評審：先理解對方的思路，再指出證據不足、結論過強或方法上的漏洞，並給出改進建議。你區分事實與推測，不確定時坦率地說「我不確定」，必要時建議查證來源。語氣專業但輕鬆，偶爾帶點小幽默。你用自然的中文聊天，不說教，不機械。",
  editor: "你叫 Koko，是使用者的本地 AI 伴侶，也是一位資深的寫作編輯。你幫對方打磨文字：指出冗餘、邏輯跳躍、用詞不準和結構問題，給出具體的改寫建議，並說明每處改動的理由。你尊重作者的原意和風格，只提議、不強加；中英文寫作都能潤色。語氣專業、坦率而友善。你用自然的中文聊天，不說教，不機械。",
};

/** Get personality preset by key for the given language. The built-in texts are
 * written with DEFAULT_AI_NAME, but the AI name is user-editable (double-click the
 * header name) — pass `name` to substitute it into the prompt. */
export function getPersonalityPreset(key, lang = "en", name = "") {
  let text;
  if (lang === "zh-Hant") text = PERSONALITY_PRESETS_ZH_HANT[key] || PERSONALITY_PRESETS[key];
  else if (lang === "zh") text = PERSONALITY_PRESETS[key];
  else text = PERSONALITY_PRESETS_EN[key] || PERSONALITY_PRESETS[key];
  // split/join, not replaceAll: a replacement string containing "$" patterns
  // ($&, $$, $'…) would otherwise be interpreted and corrupt the prompt.
  if (text && name) text = text.split(DEFAULT_AI_NAME).join(name);
  return text;
}

// Tag colors
export const TAG_COLORS = ["#7ecfcf", "#f7a8c4", "#a8d8a8", "#f5d78e", "#c4b5fd", "#fca5a5", "#93c5fd", "#fdba74"];

// Named size presets accepted by `--size` (case-insensitive), e.g. `--size 1080p`.
export const SIZE_PRESETS = {
  "480p": "854x480",
  "480p-portrait": "480x854",
  "720p": "1280x720",
  "720p-portrait": "720x1280",
  "1080p": "1920x1080",
  "1080p-portrait": "1080x1920",
  // 21:9 reduces to 7:3, so 1792×768 is the ratio exactly — and both sides divide by 64,
  // the strictest dimMult any builder uses, so nothing snaps it off-ratio. Same value as
  // the dropdown's ultrawide entry; the flag and the menu must not disagree.
  // Named "ultrawide" rather than "21:9": every other preset here is a word, and a colon
  // now means something specific elsewhere in the command surface (a model id's mode).
  // No portrait twin: a 9:21 frame is not a thing anyone asks a model for.
  //
  // The /64 rule quantizes this ratio hard: exact 7:3 needs width 7k and height 3k with
  // both divisible by 64, so k must itself be a multiple of 64 — the ONLY exact rungs are
  // 448×192, 896×384, 1344×576 and 1792×768. Small is 896×384: a quarter of the pixels,
  // so roughly 4× faster, for drafting. Its 384px side is under what most current
  // checkpoints are trained at, so expect it to be rougher than the full size — that is
  // the trade it exists to make.
  "ultrawide-small": "896x384",
  ultrawide: "1792x768",
  "2k": "2560x1440",
  "2k-portrait": "1440x2560",
  "4k": "3840x2160",
  "4k-portrait": "2160x3840",
};

// Avatar SVG styles.
//
// The CSS state machine drives twelve parts by class name (avatarHead,
// avatarEyes, avatarMouthOpen, …). A style missing one silently loses an
// animation, and six hand-written copies of the same face made that contract
// easy to break. buildFace() emits all twelve from a spec, so a style declares
// only what is actually its own: colours, eye and mouth shape, and raw markup
// for hair, ears and accessories.
//
// Paint order: back (ears, back hair) → head → front (fringe, muzzle) → cheeks,
// eyes, mouth → extras (bow, halo, whiskers, nose).

const EYE_X = [45, 75];      // both eyes, mirrored about the 60-wide viewBox
const HEAD_Y = 62;

// The open smile is filled with its own stroke colour at 20%, so the two cannot
// drift apart the way two hand-written literals can.
function fill20(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.2)`;
}

// Shared by the three human styles; the animal ones draw their own.
const MOUTH_DEFAULT = {
  neutral: "M52 80 Q60 86 68 80",
  open: { cx: 60, cy: 82, rx: 5, ry: 4 },
  smile: "M48 78 Q60 92 72 78",
  width: 2.2,
};

function buildFace({ skin, eyes, mouth, cheeks, back = "", front = "", extras = "" }) {
  const lidH = eyes.lidH || 14;

  const eyeGroups = EYE_X.map((x, i) => {
    const side = i === 0 ? "Left" : "Right";
    // A slit pupil sits on the eye centre; round-eyed styles skip it entirely.
    const pupil = eyes.pupil
      ? `<ellipse cx="${x}" cy="${eyes.y}" rx="${eyes.pupil.rx}" ry="${eyes.pupil.ry}" fill="${eyes.pupil.fill}"/>`
      : "";
    return `<g class="avatarEye${side}"><ellipse cx="${x}" cy="${eyes.y}" rx="${eyes.rx}" ry="${eyes.ry}" fill="${eyes.color}"/>${pupil}`
      + `<ellipse cx="${x - 1}" cy="${eyes.y + eyes.hl.dy}" rx="${eyes.hl.rx}" ry="${eyes.hl.ry}" fill="#fff"/></g>`;
  }).join("");

  // Painted skin-coloured and scaled flat; the blink scales them back to 1.
  const lids = EYE_X.map((x, i) => {
    const side = i === 0 ? "Left" : "Right";
    return `<rect class="avatarEyelid${side}" x="${x - 7}" y="${eyes.y - lidH / 2}" width="14" height="${lidH}" rx="7"`
      + ` fill="${skin}" transform-origin="${x}px ${eyes.y}px" transform="scale(1,0)"/>`;
  }).join("");

  // ^^ arcs, always 6 units above the eye line whatever the style's eye height.
  const happy = EYE_X.map((x) =>
    `<path d="M${x - 6} ${eyes.y} Q${x} ${eyes.y - 6} ${x + 6} ${eyes.y}" stroke="${eyes.color}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
  ).join("");

  const join = mouth.linejoin ? ` stroke-linejoin="round"` : "";
  const o = mouth.open;

  return `${back}`
    + `<ellipse class="avatarHead" cx="60" cy="${HEAD_Y}" rx="34" ry="36" fill="${skin}"/>`
    + `${front}`
    + `<g class="avatarCheeks" opacity="0">`
      + `<ellipse cx="38" cy="${cheeks.y}" rx="${cheeks.rx}" ry="5" fill="${cheeks.color}" opacity="${cheeks.opacity}"/>`
      + `<ellipse cx="82" cy="${cheeks.y}" rx="${cheeks.rx}" ry="5" fill="${cheeks.color}" opacity="${cheeks.opacity}"/></g>`
    + `<g class="avatarEyes">${eyeGroups}${lids}</g>`
    + `<g class="avatarHappyEyes" opacity="0">${happy}</g>`
    + `<g class="avatarMouth">`
      + `<path class="avatarMouthNeutral" d="${mouth.neutral}" stroke="${mouth.color}" stroke-width="${mouth.width}" fill="none" stroke-linecap="round"${join}/>`
      + `<ellipse class="avatarMouthOpen" cx="${o.cx}" cy="${o.cy}" rx="${o.rx}" ry="${o.ry}" fill="${mouth.color}" opacity="0"/>`
      + `<path class="avatarMouthSmile" d="${mouth.smile}" stroke="${mouth.color}" stroke-width="${mouth.width}" fill="${fill20(mouth.color)}" stroke-linecap="round" opacity="0"/></g>`
    + `${extras}`;
}

export const AVATAR_STYLES = {
  "dark-girl": {
    svg: buildFace({
      skin: "#fce4d6",
      eyes: { y: 64, rx: 5.5, ry: 6, color: "#2d2d3a", hl: { dy: -1.5, rx: 2, ry: 2.2 } },
      mouth: { ...MOUTH_DEFAULT, color: "#c96b7a" },
      cheeks: { color: "#f5a0b8", y: 74, rx: 8, opacity: 0.6 },
      back: `<ellipse cx="60" cy="52" rx="42" ry="44" fill="#2d2d3a"/>`,
      front: `<path d="M26 48 Q36 22 60 20 Q84 22 94 48 Q88 34 60 32 Q32 34 26 48Z" fill="#2d2d3a"/>`
        + `<path d="M28 50 Q32 42 42 40 L38 56 Q30 54 28 50Z" fill="#2d2d3a"/>`
        + `<path d="M92 50 Q88 42 78 40 L82 56 Q90 54 92 50Z" fill="#2d2d3a"/>`,
      extras: `<circle cx="82" cy="36" r="4" fill="#b94a6d"/><circle cx="78" cy="34" r="2.5" fill="#b94a6d" opacity="0.7"/>`
        + `<circle cx="86" cy="34" r="2.5" fill="#b94a6d" opacity="0.7"/>`,
    }),
  },
  "blonde-angel": {
    svg: buildFace({
      skin: "#fff0e0",
      eyes: { y: 64, rx: 5, ry: 5.5, color: "#4a90d9", hl: { dy: -1.5, rx: 2, ry: 2 } },
      mouth: { ...MOUTH_DEFAULT, color: "#e07a8f" },
      cheeks: { color: "#ffb3c6", y: 74, rx: 8, opacity: 0.5 },
      back: `<ellipse cx="60" cy="50" rx="44" ry="42" fill="#f5d78e"/>`,
      front: `<path d="M24 52 Q34 18 60 16 Q86 18 96 52 Q90 36 60 34 Q30 36 24 52Z" fill="#f5d78e"/>`
        + `<path d="M22 54 Q28 44 38 43 L34 60 Q26 56 22 54Z" fill="#f5d78e"/>`
        + `<path d="M98 54 Q92 44 82 43 L86 60 Q94 56 98 54Z" fill="#f5d78e"/>`,
      extras: `<path d="M52 16 Q60 8 68 16" stroke="#f5d78e" stroke-width="3" fill="none" stroke-linecap="round"/>`
        + `<circle cx="60" cy="10" r="3" fill="#ffe066"/>`,
    }),
  },
  "pink-girl": {
    svg: buildFace({
      skin: "#fce4d6",
      eyes: { y: 64, rx: 5.5, ry: 6, color: "#d94f8a", hl: { dy: -2, rx: 2.2, ry: 2.5 } },
      mouth: { ...MOUTH_DEFAULT, color: "#e05588" },
      cheeks: { color: "#ff8fab", y: 74, rx: 8, opacity: 0.5 },
      back: `<ellipse cx="60" cy="50" rx="43" ry="44" fill="#f7a8c4"/>`,
      front: `<path d="M25 50 Q35 20 60 18 Q85 20 95 50 Q88 34 60 32 Q32 34 25 50Z" fill="#f7a8c4"/>`
        + `<path d="M26 52 Q30 44 40 42 L36 58 Q28 54 26 52Z" fill="#f7a8c4"/>`
        + `<path d="M94 52 Q90 44 80 42 L84 58 Q92 54 94 52Z" fill="#f7a8c4"/>`,
      extras: `<circle cx="44" cy="20" r="3" fill="#fff" opacity="0.7"/><circle cx="76" cy="22" r="2" fill="#fff" opacity="0.5"/>`,
    }),
  },
  "cat-ear": {
    svg: buildFace({
      skin: "#fce4d6",
      // The only slit-pupil style, and the only one whose taller eye needs a
      // taller lid to cover it on a blink.
      eyes: {
        y: 64, rx: 5.5, ry: 6.5, color: "#4a8c3f", lidH: 16,
        pupil: { rx: 2, ry: 5, fill: "#1a1a1a" }, hl: { dy: -2, rx: 2, ry: 2 },
      },
      mouth: {
        neutral: "M54 80 L60 84 L66 80", open: { cx: 60, cy: 82, rx: 4, ry: 3.5 },
        smile: "M50 78 Q60 90 70 78", width: 2, color: "#c96b7a", linejoin: true,
      },
      cheeks: { color: "#f5a0b8", y: 74, rx: 8, opacity: 0.6 },
      back: `<polygon points="30,40 42,12 52,44" fill="#5c4a3a"/><polygon points="90,40 78,12 68,44" fill="#5c4a3a"/>`
        + `<polygon points="33,38 42,18 49,42" fill="#ffb5c8"/><polygon points="87,38 78,18 71,42" fill="#ffb5c8"/>`
        + `<ellipse cx="60" cy="52" rx="40" ry="42" fill="#5c4a3a"/>`,
      front: `<path d="M28 50 Q38 24 60 22 Q82 24 92 50 Q86 36 60 34 Q34 36 28 50Z" fill="#5c4a3a"/>`,
      extras: `<line x1="20" y1="68" x2="36" y2="70" stroke="#5c4a3a" stroke-width="1.2" opacity="0.4"/>`
        + `<line x1="20" y1="72" x2="36" y2="72" stroke="#5c4a3a" stroke-width="1.2" opacity="0.4"/>`
        + `<line x1="84" y1="70" x2="100" y2="68" stroke="#5c4a3a" stroke-width="1.2" opacity="0.4"/>`
        + `<line x1="84" y1="72" x2="100" y2="72" stroke="#5c4a3a" stroke-width="1.2" opacity="0.4"/>`,
    }),
  },
  "bunny": {
    svg: buildFace({
      skin: "#fff5f5",
      eyes: { y: 64, rx: 5, ry: 6, color: "#d94070", hl: { dy: -2, rx: 2.2, ry: 2.5 } },
      mouth: {
        neutral: "M55 80 Q60 84 65 80", open: { cx: 60, cy: 82, rx: 4, ry: 3 },
        smile: "M50 78 Q60 90 70 78", width: 2, color: "#e07a8f",
      },
      cheeks: { color: "#ffb5c8", y: 76, rx: 9, opacity: 0.5 },
      back: `<ellipse cx="44" cy="24" rx="8" ry="22" fill="#fff"/><ellipse cx="76" cy="24" rx="8" ry="22" fill="#fff"/>`
        + `<ellipse cx="44" cy="24" rx="5" ry="18" fill="#ffb5c8"/><ellipse cx="76" cy="24" rx="5" ry="18" fill="#ffb5c8"/>`
        + `<ellipse cx="60" cy="54" rx="40" ry="40" fill="#fff"/>`,
      // The only style with no fringe: the ears carry the silhouette instead.
      extras: `<ellipse cx="60" cy="88" rx="3" ry="2.5" fill="#ffccd5"/>`,
    }),
  },
  "fox": {
    svg: buildFace({
      skin: "#fff5e6",
      // Eyes ride 2 units higher than every other style; the lid box and the ^^
      // arcs follow from that rather than being redrawn.
      eyes: { y: 62, rx: 5, ry: 5.5, color: "#8b4513", hl: { dy: -1.5, rx: 2, ry: 2 } },
      mouth: {
        neutral: "M54 78 Q60 82 66 78", open: { cx: 60, cy: 80, rx: 4, ry: 3.5 },
        smile: "M50 76 Q60 88 70 76", width: 2, color: "#c96b4a",
      },
      cheeks: { color: "#ffb380", y: 74, rx: 8, opacity: 0.6 },
      back: `<polygon points="26,44 38,10 52,42" fill="#f0832a"/><polygon points="94,44 82,10 68,42" fill="#f0832a"/>`
        + `<polygon points="30,42 38,18 48,40" fill="#fff" opacity="0.8"/><polygon points="90,42 82,18 72,40" fill="#fff" opacity="0.8"/>`
        + `<ellipse cx="60" cy="52" rx="42" ry="42" fill="#f0832a"/>`,
      front: `<path d="M30 52 Q40 26 60 24 Q80 26 90 52 Q84 38 60 36 Q36 38 30 52Z" fill="#f0832a"/>`
        + `<path d="M44 60 Q60 90 76 60" fill="#fff" opacity="0.5"/>`,
      extras: `<ellipse cx="60" cy="76" rx="3.5" ry="2.5" fill="#1a1a1a"/>`,
    }),
  },
};