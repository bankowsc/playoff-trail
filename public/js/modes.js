// public/js/modes.js — how each game looks. No team data in here: the browser never receives histories.
// Dot classes: t1..t6 and u1..u8 are colored in css/style.css.

export const MODE_ORDER = ["pro", "ncaa", "ucl"];

export const MODES = {
  pro: {
    label: "Pro", blurb: "NFL · MLB · NBA · NHL",
    prefix: "t",
    icons: ["✕", "", "", "", "", "🏆", ""],
    labels: ["Sport", "Conference", "Division"],
    legend: [
      ["t1", "", "First round / wild card"], ["t2", "", "Divisional"], ["t3", "", "Conference final"],
      ["t4", "", "Lost the final"], ["t5", "🏆", "Won the title"], ["x", "✕", "Missed"], ["t6", "", "Didn't exist"],
    ],
  },
  ncaa: {
    label: "NCAA", blurb: "Men's basketball",
    prefix: "u",
    icons: ["✕", "", "", "", "", "", "", "🏆", ""],
    labels: ["Sport", "Conference", "Colors"],
    legend: [
      ["u1", "", "First Four / R64"], ["u2", "", "Round of 32"], ["u3", "", "Sweet 16"], ["u4", "", "Elite 8"],
      ["u5", "", "Final Four"], ["u6", "", "Runner-up"], ["u7", "🏆", "Champion"], ["x", "✕", "Missed"],
    ],
  },
  ucl: {
    label: "UCL", blurb: "Champions League",
    prefix: "t",
    icons: ["✕", "", "", "", "", "🏆", ""],
    labels: ["Sport", "Country", "League"],
    legend: [
      ["t1", "", "Group stage / R16"], ["t2", "", "Quarterfinal"], ["t3", "", "Semifinal"],
      ["t4", "", "Lost the final"], ["t5", "🏆", "Winner"], ["x", "✕", "Missed"],
    ],
  },
};
