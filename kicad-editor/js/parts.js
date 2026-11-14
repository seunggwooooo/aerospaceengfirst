// What a part is, in plain words, guessed from its reference designator.
const KINDS = [
  [/^RV|^RP|^VR|^POT/, '가변저항'], [/^RN/, '저항 어레이'], [/^R/, '저항'],
  [/^C/, '커패시터'], [/^FB/, '페라이트 비드'], [/^F/, '퓨즈'], [/^L(?!ED|S)/, '인덕터'],
  [/^LED/, 'LED'], [/^LS|^BZ|^SP/, '스피커·부저'], [/^D/, '다이오드'], [/^Q/, '트랜지스터'],
  [/^U|^IC/, '집적회로 (IC)'], [/^JP/, '점퍼'], [/^J|^P|^CN|^CON|^X(?!TAL)/, '커넥터'],
  [/^SW|^S\d/, '스위치'], [/^Y|^XTAL/, '크리스털·발진기'], [/^TP/, '테스트 포인트'],
  [/^H|^MH/, '장착 구멍'], [/^BT/, '배터리'], [/^K/, '릴레이'], [/^T/, '트랜스포머'],
  [/^M/, '모터'], [/^A/, '모듈'], [/^FID/, '피듀셜 마크'], [/^#PWR|^#FLG/, '전원 기호'],
];

export function partKind(ref, hint) {
  const r = (ref || '').toUpperCase();
  const h = (hint || '').toLowerCase();
  if (/^D/.test(r) && /led/.test(h)) return 'LED';
  if (/^C/.test(r) && /(cp_|elec|polar|tantal)/.test(h)) return '전해·탄탈 커패시터 (극성 있음)';
  if (/^D/.test(r) && /zener/.test(h)) return '제너 다이오드';
  if (/^D/.test(r) && /schottky/.test(h)) return '쇼트키 다이오드';
  if (/^U/.test(r) && /(regulator|ldo|lm78|ams1117|lm317)/.test(h)) return '전압 레귤레이터 (IC)';
  if (/^(J|P)/.test(r) && /usb/.test(h)) return 'USB 커넥터';
  for (const [re, name] of KINDS) if (re.test(r)) return name;
  return '';
}

const PIN_TYPES = {
  input: '입력', output: '출력', bidirectional: '양방향', tri_state: '3상', passive: '수동',
  power_in: '전원 입력', power_out: '전원 출력', open_collector: '오픈 컬렉터', open_emitter: '오픈 이미터',
  no_connect: '연결 안 함', unspecified: '미지정', free: '자유',
};
export const pinType = (t) => PIN_TYPES[(t || '').split('+')[0]] || t || '';

export function refCompare(a, b) {
  const ma = /^(\D*)(\d*)/.exec(a || ''), mb = /^(\D*)(\d*)/.exec(b || '');
  return ma[1].localeCompare(mb[1]) || (+ma[2] || 0) - (+mb[2] || 0) || (a || '').localeCompare(b || '');
}
