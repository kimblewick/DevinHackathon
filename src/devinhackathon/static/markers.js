"use strict";
// Lays out the fixed marker files /markers/1.svg .. /markers/20.svg.
const COUNT = 20;
const sheet = document.getElementById("sheet");
for (let id = 1; id <= COUNT; id++) {
  const div = document.createElement("div");
  div.className = "marker";
  const img = document.createElement("img");
  img.src = `/markers/${id}.svg`;
  img.alt = `marker ${id}`;
  const lbl = document.createElement("div");
  lbl.className = "lbl";
  lbl.textContent = "#" + id;
  div.appendChild(img);
  div.appendChild(lbl);
  sheet.appendChild(div);
}
