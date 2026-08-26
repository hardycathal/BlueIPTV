// theme.js
// Central colour palette + shared style tokens for the whole app.
//
// Brand palette:
//   #1B2A4A Navy       — surfaces / panels
//   #8B1FA8 Purple     — primary accent (buttons, active states)
//   #2E8B57 Green      — success / live / online
//   #B8CDE8 Light Blue — secondary text, subtle highlights

export const C = {
  // backgrounds
  bg:        '#101A30', // app background (darkened navy)
  surface:   '#1B2A4A', // cards, rows, headers (brand navy)
  surface2:  '#24365C', // raised / pressed surfaces
  border:    '#35496F', // hairlines and outlines

  // brand
  accent:       '#8B1FA8', // purple — primary actions
  accentSoft:   '#A94BC4', // lighter purple — icons, highlights on dark
  green:        '#2E8B57', // success, live badges, active playlist
  blue:         '#B8CDE8', // light blue — secondary text / labels

  // text
  text:      '#FFFFFF',
  textSoft:  '#B8CDE8', // light blue doubles as soft text
  textMuted: '#7E93B8',

  // misc
  danger:    '#E25563',
  overlay:   'rgba(16,26,48,0.55)',
};

export const R = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
};

// Gradient stop tuples for expo-linear-gradient (cinematic look).
export const G = {
  // hero navigation cards
  live:    ['#2A1B4A', '#8B1FA8'],           // navy -> purple
  movies:  ['#16324A', '#2E8B57'],           // navy -> green
  series:  ['#1B2A4A', '#3E5F8F'],           // navy -> steel blue
  catchup: ['#1B2A4A', '#5E2D8B'],           // navy -> deep purple
  // dark fade laid over poster bottoms so titles stay readable
  posterFade: ['transparent', 'rgba(10,16,30,0.92)'],
  // player chrome
  playerTop:    ['rgba(10,16,30,0.92)', 'transparent'],
  playerBottom: ['transparent', 'rgba(10,16,30,0.95)'],
  // generic surface sheen for sheets/headers
  sheet: ['#24365C', '#1B2A4A'],
  // primary button
  button: ['#A94BC4', '#8B1FA8'],
};

// Bottom tab bar style — shared so screens (e.g. the Player, which hides the
// bar during playback) can restore it exactly.
export const TABBAR = {
  backgroundColor: C.surface,
  borderTopColor: C.border,
  height: 40,
  paddingBottom: 2,
  paddingTop: 2,
};

export default { C, R, G, TABBAR };
