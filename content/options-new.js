async function sanitizeSetting(option, value) {

  switch (option) {
    case "dpi_factor_textbox":
      value = Number.parseFloat(value);
      if (!Number.isFinite(value)) {
        value = (await messenger.storage.local.get(Object.fromEntries(
            [[option, defaultSettings[option]]])))[option];
      } else {
        value = 0.1 * Math.round(10 * Number.parseFloat(value));
        value = Math.max(1, Math.min(value, 8));
      }
      break;
    case "fontpx_textbox":
      value = Number.parseInt(value);
      if (!Number.isFinite(value)) {
        value = (await messenger.storage.local.get(Object.fromEntries(
            [[option, defaultSettings[option]]])))[option];
      } else {
        value = Math.max(1, Math.min(value, 999));
      }
      break;
  }
  return value;
}

let options = {
  textBoxes: [
    "latex_textbox",
    "dvipng_textbox",
    "fontpx_textbox",
    "dpi_factor_textbox",
    "template_textbox",
  ],
  checkBoxes: [
    "log_checkbox",
    "autoFontSize_radio",
    "debug_checkbox",
    "keeptempfiles_checkbox",
  ],
}

let defaultSettings = {
  latex_textbox: "",
  dvipng_textbox: "",
  autoFontSize_radio: true,
  fontpx_textbox: 16,
  dpi_factor_textbox: 2,
  log_checkbox: true,
  debug_checkbox: false,
  keeptempfiles_checkbox: false,
  template_textbox: "<template dummy>"
};

function restoreOptions() {

  function updateOptionsPanel(values) {
    options.textBoxes.forEach(option => {
      document.querySelector("#" + option).value = values[option];
      updatePage(option, values[option]);
    });
    options.checkBoxes.forEach(option => {
      document.querySelector("#" + option).checked = values[option];
      updatePage(option, values[option]);
    });
  }

  messenger.storage.local.get(defaultSettings).then(updateOptionsPanel);
}

async function onSettingChanged(event) {
  event.preventDefault();
  let node = event.currentTarget;
  let option = node.id;
  let value;
  if (option == "fixedFontSize_radio") {
    option = "autoFontSize_radio";
    node = document.querySelector("#" + option);
  }
  if (options.textBoxes.includes(option)) {
    value = await sanitizeSetting(option, node.value);
    node.value = value;
  } else if (options.checkBoxes.includes(option)) {
    value = node.checked;
  }
  console.log(option, value);
  messenger.storage.local.set(Object.fromEntries([[option, value]]));
  updatePage(option, value);
}

function updatePage(option, value) {
  if (option == "autoFontSize_radio") {
    let fontSizePxTextBox = document.querySelector("#fontpx_textbox");
    if (value) {
      fontSizePxTextBox.disabled = true;
    } else {
      fontSizePxTextBox.removeAttribute("disabled");
      document.querySelector("#fixedFontSize_radio").checked = true;
    }
  }
}

document.addEventListener("DOMContentLoaded", restoreOptions);

for (option in defaultSettings) {
  let node = document.querySelector("#" + option);
  if (node) node.addEventListener("change", onSettingChanged);
}
document.querySelector("#fixedFontSize_radio")
    .addEventListener("change", onSettingChanged);
