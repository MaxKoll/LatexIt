var tblatex = {
  on_latexit: null,
  on_middleclick: null,
  on_undo: null,
  on_undo_all: null,
  on_insert_complex: null,
  on_open_options: null,
  on_load:null,
  on_unload: null
};

(function () {
  var isWindows = ("@mozilla.org/windows-registry-key;1" in Components.classes);

  if (document.location.href != "chrome://messenger/content/messengercompose/messengercompose.xhtml")
    return;

  var g_undo_func = null;
  var g_image_cache = {};

  function sleep (delay) {
      return new Promise(function(resolve, reject) {
          window.setTimeout(resolve, delay);
      });
  }

  function push_undo_func(f) {
    var old_undo_func = g_undo_func;
    var g = function () {
      g_undo_func = old_undo_func;
      f();
    };
    g_undo_func = g;
  }

  var prefs = Components.classes["@mozilla.org/preferences-service;1"]
    .getService(Components.interfaces.nsIPrefService)
    .getBranch("tblatex.");


  /**
   * Returns all LaTeX expressions found under rootNode as an array of text nodes.
   * Text nodes that contain both non-LaTeX text and LaTeX expressions are being
   * split up accordingly.
   */
  function prepareLatexNodes(rootNode) {

    let regex = /\$\$[^\$]+\$\$|\$[^\$]+\$|\\\[.*?\\\]|\\\(.*?\\\)/g;

    const splitNodeIfHasLatex = (node, latexNodes) => {
      let latexExpressions = node.textContent.match(regex) || [];
      latexExpressions.forEach(latex => {
        let latexStrPos = node.textContent.indexOf(latex);
        let latexNode = (latexStrPos > 0) ? node.splitText(latexStrPos) : node;
        node = (latexNode.textContent.length > latex.length) ?
            latexNode.splitText(latex.length) : latexNode;
        latexNodes.push(latexNode);
      });
      return node;
    };

    const nextNodeInTree = (node, includeChildNodes = true) => {
      if (includeChildNodes && node.hasChildNodes()) {
        return node.firstChild;
      } else {
        while (!node.nextSibling && node != rootNode) {
          node = node.parentNode;
        }
        return node.nextSibling;
      }
    };

    rootNode.normalize();
    let latexNodes = [];
    let node = rootNode.firstChild;

    while (node) {
      if (node.nodeType == Node.TEXT_NODE) {
        node = splitNodeIfHasLatex(node, latexNodes);
      }
      node = nextNodeInTree(node);
      if (node && node.id == "tblatex-log") {
        node = nextNodeInTree(node, false);
      }
    }

    return latexNodes;
  }


  function errorToConsole(e, message = "") {
    let originalMessage = e.message;
    e.message = "LaTeX It! -- " + (message ? message + "\n" : "") + e.message;
    console.log(e);
    e.message = originalMessage;
  }


  /**
   * Returns a random alphanumeric string of given length.
   */
  const randomStringBase36 = (length) => {
    let alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
    let randomChars = [];
    while (randomChars.length < length) {
      randomChars.push(alphabet[Math.floor(36 * Math.random())]);
    }
    return randomChars.join("");
  };


  /* Returns [st, src, depth, height, width] where:
   * - st is 0 if everything went ok and 1 if some error was found but the
   *   image was nonetheless generated
   * - src is the local path of the image if generated
   * - depth is the number of pixels from the bottom of the image to the
   *   baseline of the image
   * - height is the total height of the generated image in pixels
   * - width is the total width of the generated image in pixels
   * */
  async function run_latex(latex_expr, font_px, fontColor, log) {

    var st = 0;

    let deleteTempFiles = !prefs.getBoolPref("keeptempfiles");

    const initFile = (path, pathAppend = "") => {
      let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      try {
        file.initWithPath(path);
        file.append(pathAppend);
        return file;
      } catch (e) {
        let message = "Error while trying to initialize " +
            "the following path:\n" + file.path;
        errorToConsole(e, message);
        log.write(message, {type: "warning"});
        return {exists() { return false; }};
      }
    };

    const removeFile = (file) => {
      try {
        file.remove(false);
      } catch (e) {
        let message = "Error while trying to remove " +
            "this temporary file:\n" + file.path;
        errorToConsole(e, message);
        log.writeDebug(message, {type: "warning"});
      }
    }
    let imgKey = latex_expr + ";" + font_px + ";" + fontColor.join(" ");
    if (g_image_cache[imgKey]) {
      let imgPath = g_image_cache[imgKey].path;
      if (initFile(imgPath).exists()) {
        let depth = g_image_cache[imgKey].depth;
        let height = g_image_cache[imgKey].height;
        let width = g_image_cache[imgKey].width;
        let logEntry = log.write("Image was already generated.");
        log.writeDebug("Image was already generated (depth=" + depth +
            ", height=" + height + ", width=" + width + "):\n" + imgPath,
            {replace: logEntry});
        return [0, imgPath, depth, height, width];
      } else {
        delete g_image_cache[imgKey];
      }
    }

    // Check if the LaTeX document contains the required packages.
    // At the moment, it checks for the minimum of
    //   \usepackage[active]{preview}
    // which must not be commented out. The 'preview' package is needed
    // for the baseline alignment with the surrounding text.
    var re = /^[^%]*\\usepackage\[(.*,\s*)?active(,.*)?\]{(.*,\s*)?preview(,.*)?}/m;
    var package_match = latex_expr.match(re);
    if (!package_match) {
      throw new Error(
          "The mandatory package 'preview' cannot be found in the " +
          "LaTeX document. Please add the following line in the " +
          "preamble of your LaTeX template or complex expression:\n\n" +
          "\\usepackage[active,displaymath,textmath]{preview}\n\n" +
          "Note: The preview package is needed for the alignment of the " +
          "generated images with the surrounding text.");
    }

    /* \u00a0 = non-breaking space. \u2011 = non-breaking hyphen. */
    let logHintAddonOptions = "☰ ➜ Add-ons ➜ LaTeX It!"
        .replace(/ /g, "\u00a0").replace(/-/, "\u2011");
    let latex_bin = initFile(prefs.getCharPref("latex_path"));
    if (!latex_bin.exists()) {
      throw new Error("Cannot find the 'latex' executable. " +
          "Please make sure the correct path is set in the " +
          "add-on's options dialog (" + logHintAddonOptions + ").");
    }
    let dvipng_bin = initFile(prefs.getCharPref("dvipng_path"));
    if (!dvipng_bin.exists()) {
      throw new Error("The 'dvipng' executable cannot be found. " +
          "Please make sure the correct path is set in the " +
          "add-on's options dialog (" + logHintAddonOptions + ").");
    }
    // Alignment of the inserted pictures to the text baseline works as follows
    // (see also https://github.com/protz/LatexIt/issues/36):
    // 1. Have the LaTeX package 'preview' available.
    // 2. Into the preamble of the LaTeX document insert:
    //      \usepackage[active,textmath]{preview}
    // 3. Run a shell that
    //    (a) calls dvipng with the options '--depth --height --width' and
    //    (b) redirects the standard output into a temporary file.
    //    This is necessary because it seems that it is impossible to get the
    //    standard output directly (https://stackoverflow.com/a/10216452).
    // 4. Parse the output of the command for the depth, height and width
    //    values. A typical output is:
    //      This is dvipng 1.15 Copyright 2002-2015 Jan-Ake Larsson
    //      [1 depth=4 height=24 width=103]
    // 5. Return these values in addition to the values already returned.
    // 6. Translate inserted images by minus depth pixels vertically.
    //
    // On all platforms, nsIProcess will escape the arguments, that is:
    // - Escape backslashes (\) and double quotes (") with backslashes (\).
    // - Wrap the argument in double quotes (") if it contains white-space.
    // Unfortunately this produces arguments that are not compatible with
    // Windows CMD. Work around this by adding echo statements in a cunning
    // way.
    const runShellCmdInDir = (dir, args) => {
      const addQuotesIfWhitespace = (arg) => {
        return arg.indexOf(" ") < 0 ? arg : "\"" + arg + "\"";
      };
      let dirQ = addQuotesIfWhitespace(dir);
      let shellBin;
      let shellArgs;
      if (isWindows) {
        let env = Cc["@mozilla.org/process/environment;1"]
            .getService(Ci.nsIEnvironment);
        shellBin = initFile(env.get("COMSPEC"));
        // /c "echo " \" && cd /d <dir> && <args> && echo \"
        shellArgs = ["/c", "echo ", "\"", "&&", "cd", "/d", dir, "&&",
            ...args, "&&", "echo", "\""];
      } else {
        shellBin = initFile("/bin/sh");
        let argsQ = args.map(addQuotesIfWhitespace).join(" ");
        // -c "cd <dir> && <args>"
        shellArgs = ["-c", "cd " + dirQ + " && " + argsQ];
      }
      let shellProcess = Cc["@mozilla.org/process/util;1"]
          .createInstance(Ci.nsIProcess);
      shellProcess.init(shellBin);
      shellProcess.startHidden = true;

      let processObserver;

      let exitValue = new Promise((resolve, reject) => {
        processObserver = (subject, topic, data) => {
          log.writeDebug("\n(Finished with exit code " +
              shellProcess.exitValue + ".)", {append: logEntry});
          resolve(shellProcess.exitValue);
        };
      });

      shellProcess.runAsync(shellArgs, shellArgs.length, processObserver);

      let shellPathQ = addQuotesIfWhitespace(shellBin.path);
      let argsQ = args.map(addQuotesIfWhitespace).join(" ");
      let cmd = isWindows ?
          shellPathQ + " /c \"cd /d " + dirQ + " && " + argsQ + "\"" :
          shellPathQ + " -c 'cd " + dirQ + " && " + argsQ + "'";
      let logEntry = log.writeDebug("I called:\n" + cmd);

      return exitValue;
    };

    var temp_dir = Components.classes["@mozilla.org/file/directory_service;1"].
      getService(Components.interfaces.nsIProperties).
      get("TmpD", Components.interfaces.nsIFile).path;

    // Random base36 string of length 24 has ~124 bits of entropy.
    // UUIDs usually have 121 to 123 bits of entropy.
    let temp_file_noext = "tblatex-" + randomStringBase36(24);

    let texFile = initFile(temp_dir, temp_file_noext + ".tex");

    var foStream = Components.classes["@mozilla.org/network/file-output-stream;1"].
      createInstance(Components.interfaces.nsIFileOutputStream);
    // 0x02 PR_WRONLY       Open for writing only.
    // 0x08 PR_CREATE_FILE  If the file does not exist, it is created.
    //                      If the file exists, this flag has no effect.
    // 0x20 PR_TRUNCATE     If the file exists, its length is truncated to 0.
    foStream.init(texFile, 0x02 | 0x08 | 0x20, 0666, 0);
    // if you are sure there will never ever be any non-ascii text in data you can
    // also call foStream.writeData directly
    var converter = Components.classes["@mozilla.org/intl/converter-output-stream;1"].
      createInstance(Components.interfaces.nsIConverterOutputStream);
    converter.init(foStream, "UTF-8", 0, 0);
    converter.writeString(latex_expr);
    converter.close();

    let exitValue = await runShellCmdInDir(temp_dir, [
      latex_bin.path,
      "-interaction=batchmode",
      temp_file_noext + ".tex"
    ]);

    let logEntryLatexExitValue;
    if (exitValue) {
      st = 1;
      logEntryLatexExitValue = log.write("LaTeX process returned " +
          exitValue + ". Proceeding anyway.", {type: "warning"});
    }

    let auxFile = initFile(temp_dir, temp_file_noext + ".aux");
    let dviFile = initFile(temp_dir, temp_file_noext + ".dvi");
    let logFile = initFile(temp_dir, temp_file_noext + ".log");

    if (deleteTempFiles) {
      removeFile(auxFile);
      removeFile(logFile);
      removeFile(texFile);
    }

    if (!dviFile.exists()) {
      let message = "LaTeX did not output a .dvi file.";
      if (logFile.exists()) {
        message += "\nPlease examine its log to learn " +
            "what went wrong:\n" + logFile.path;
      }
      throw new Error(message);
    }

    if (logEntryLatexExitValue && logFile.exists()) {
      log.write("\nTo see what LaTeX is unhappy about, you can examine " +
          "its log:\n" + logFile.path, {append: logEntryLatexExitValue});
    }

    let png_file = initFile(temp_dir, temp_file_noext + ".png");
    let dim_file = initFile(temp_dir, temp_file_noext + "-dim.txt");

    // Output resolution to fit font size (see 'man dvipng', option -D) for LaTeX default font height 10 pt
    //
    //   -D num
    //       Set the output resolution, both horizontal and vertical, to num dpi
    //       (dots per inch).
    //
    //       One may want to adjust this to fit a certain text font size (e.g.,
    //       on a web page), and for a text font height of font_px pixels (in
    //       Mozilla) the correct formula is
    //
    //               <dpi> = <font_px> * 72.27 / 10 [px * TeXpt/in / TeXpt]
    //
    //       The last division by ten is due to the standard font height 10pt in
    //       your document, if you use 12pt, divide by 12. Unfortunately, some
    //       proprietary browsers have font height in pt (points), not pixels.
    //       You have to rescale that to pixels, using the screen resolution
    //       (default is usually 96 dpi) which means the formula is
    //
    //               <font_px> = <font_pt> * 96 / 72 [pt * px/in / (pt/in)]
    //
    //      On some high-res screens, the value is instead 120 dpi. Good luck!
    //
    // Looks like Thunderbird is one of the "proprietary browsers", at least if I assumed that
    // the font size returned is in points (and not pixels) I get the right size with a screen
    // resolution of 96.
    //
    //  -z 0-9
    //      Set the PNG compression level to num. The default compression level
    //      is 1, which selects maximum speed at the price of slightly larger
    //
    //      PNGs. The include file png.h says "Currently, valid values range
    //      from 0 - 9, corresponding directly to the zlib compression levels
    //      0 - 9 (0 - no compression, 9 - "maximal" compression). Note that tests
    //      have shown that zlib compression levels 3-6 usually perform as well as
    //      level 9 for PNG images, and do considerably fewer calculations. In the
    //      future, these values may not correspond directly to the zlib compression
    //      levels."
    //
    // As a compromise we use level 3.
    //
    //  -bg color_spec
    //      Choose background color for the images. This option will be ignored
    //      if there is a background color \special in the DVI. The color spec
    //      should be in TeX color \special syntax, e.g., 'rgb 1.0 0.0 0.0'.
    //      You can also specify 'Transparent' or 'transparent' which will give
    //      you a transparent background with the normal background as a
    //      fallback color. A capitalized 'Transparent' will give a full-alpha
    //      transparency, while an all-lowercase 'transparent' will give a
    //      simple fully transparent background with non-transparent
    //      antialiased pixels. The latter would be suitable for viewers who
    //      cannot cope with a true alpha channel.  GIF images do not support
    //      full alpha transparency, so in case of GIF output, both variants
    //      will use the latter behaviour.
    //
    // We simply assume that all modern mail viewers can handle a true
    // alpha channel, hence we use "Transparent".
    if (prefs.getBoolPref("autodpi") && font_px) {
      var font_size = parseFloat(font_px);
      log.writeDebug("Font size of surrounding text: " + font_px);
    } else {
      var font_size = prefs.getIntPref("font_px");
      log.writeDebug("Using font size of " + font_size + "px " +
          "as set in preferences.");
    }

    let dpiFactor = parseFloat(prefs.getCharPref("dpi_factor"));
    if (isNaN(dpiFactor) || dpiFactor < 1 || dpiFactor > 8) {
      log.write("Image resolution factor set to invalid value, " +
          "defaulting to 2.0", {type: warning});
      dpiFactor = 2;
    }
    let dpiUnscaled = font_size * 72.27 / 10;
    let dpi = dpiFactor * dpiUnscaled;
    log.writeDebug("Calculated resolution: " + dpiFactor.toFixed(1) + "*" +
        dpiUnscaled + "dpi = " + dpi + "dpi");

    exitValue = await runShellCmdInDir(temp_dir, [
      dvipng_bin.path,
      "--depth",
      "--height",
      "--width",
      "-D", dpi.toString(),
      "-T", "tight",
      "-fg", "RGB " + fontColor.join(" "),
      "-bg", "Transparent",
      "-z", "3",
      "-o", temp_file_noext + ".png",
      temp_file_noext + ".dvi",
      ">", temp_file_noext + "-dim.txt"
    ]);

    if (deleteTempFiles) removeFile(dviFile);

    if (exitValue) {
      throw new Error(
          "dvipng failed with exit code " + exitValue + ". Aborting.");
    }

    let logEntryImgFile = log.writeDebug("Generated image:\n" + png_file.path);

    // Read the depth (distance between base of image and baseline),
    // height and width from the dimensions file:
    let depth = 0;
    let height = 0;
    let width = 0;
    if (dim_file.exists()) {
      // https://developer.mozilla.org
      //     /en-US/docs/Archive/Add-ons/Code_snippets/File_I_O#Line_by_line
      let inputStream = Cc["@mozilla.org/network/file-input-stream;1"].
          createInstance(Ci.nsIFileInputStream);
      inputStream.init(dim_file, 0x01, 0444, 0);
      inputStream.QueryInterface(Ci.nsILineInputStream);

      // Read line by line and look for the image dimensions,
      // which are contained in a line of this general form:
      //   [%d (%d) depth=%d height=%d width=%d] \n
      // Here, %d denotes an integer. Not all space separated fields
      // are necessarily present. This applies to all versions
      // of dvipng since 2010 (see source, specifically "draw.c").
      let regex = /depth=(\d+) height=(\d+) width=(\d+)/;
      let line = {};
      let hasMore;
      do {
        hasMore = inputStream.readLine(line);
        let linematch = line.value.match(regex);
        if (linematch) {
          let depthRaw = Number(linematch[1]);
          let heightRaw = Number(linematch[1]) + Number(linematch[2]);
          let widthRaw = Number(linematch[3]);
          depth = depthRaw/dpiFactor;
          height = heightRaw/dpiFactor;
          width = widthRaw/dpiFactor;
          let dpiStr = dpiFactor.toFixed(1);
          log.writeDebug("Generated image (" +
              "depth=" + depthRaw + "/" + dpiStr + "=" + depth + ", " +
              "height=" + heightRaw + "/" + dpiStr + "=" + height + ", " +
              "width=" + widthRaw + "/" + dpiStr + "=" + width + "):\n" +
              png_file.path, {replace: logEntryImgFile});
          break;
        }
      } while(hasMore);

      inputStream.close();
      if (deleteTempFiles) removeFile(dim_file);
    } else {
      st = 1;
      log.write("dvipng did not output a dimensions file. " +
-          "Continuing without alignment.", {type: "warning"});
    }

    g_image_cache[imgKey] =
        {path: png_file.path, depth: depth, height: height, width: width};
    return [st, png_file.path, depth, height, width];
  }


  /**
   * JavaScript's default alert() function does not allow setting a title.
   * Replace it with one provided by Thunderbird.
   */
  function alert(message) {
    Services.prompt.alert(window, "LaTeX It!", message);
  }


  /*
   * The log module. It features the following functions (see module()):

   * Creates or resets the log, and inserts it into the message editor.
   *
   open()

   * Removes the log from the message editor.
   *
   close()

   * Returns the log module but with write[Debug]() bound to a specific thread.
   * All messages of this thread will be output in succession.
   *
   startThread()

   * Writes a message to the log. Has to be unmuted first by calling open().
   * Will be muted when calling close().
   *
   * Takes one or two arguments: A message string and optionally a list of
   * options, i.e. an object literal which may have the following properties:
   *
   * - type: "default", "success", "failure", "warning" or "critical".
   * Modifies line prefix, leading/trailing blank lines and color.
   *
   * - prefix: Overwrites the default behavior of only debug messages
   * having line prefixes. If ""/false, the line prefix will be removed.
   * If true, the prefix will be shown. If string of 1 to 4 characters length,
   * the String will be padded to 4 characters length and used as prefix.
   *
   * - color: Message color in CSS format. Unset by passing ""/false.
   *
   * - append: Instead of creating a new log entry, append the message
   * to an existing one by passing the return value of the corresponding
   * previous call to write[Debug]() via this option.
   *
   * - replace: Like "append", but the submitted log entry will be replaced.
   *
   * Precedence: Option "type" will overwrite appearence of a previous log
   * entry given via "append"/"replace". Options "prefix" and "color" will
   * overwrite settings implied by options "type" and "append"/"replace".
   *
   * Returns an object {node, message[, type, prefix, color]} containing
   * the newly created or modified log entry node and the passed message
   * and options.
   *
   write(message, options = {})

   * Same as write(), but will only write to the log if the debug option
   * is set.
   *
   writeDebug(message, options = {})

   */
  let log = (() => {

    let threadCount = {value: 0};

    class Entry {
      constructor({message, node, type, prefix, color}) {
        for (let property in arguments[0]) {
          Object.defineProperty(this, property, {
            value: arguments[0][property],
            enumerable: true,
            configurable: false,
            writable: false
          });
        }
      }
    }

    function open(force = false) {
      close();

      if (!force && !prefs.getBoolPref("log")) return;

      threadCount.value = 0;

      let editorDocument = GetCurrentEditor().document;

      let logNode = editorDocument.createElement("div");
      logNode.id = "tblatex-log";
      logNode.style = "position: relative; max-width: 650px; margin: 1em; " +
          "padding: 0 0.5em 0.5em; border: 1px solid #333; border-radius: 5px;" +
          "box-shadow: 2px 2px 6px #888; background: white; color: black";
      // Note: Line break of zero height will show up when copy-pasting.
      logNode.innerHTML = `
          <div style="line-height: 40px; font-size: 18px;
              font-family: sans-serif; font-weight: bold;
              border-bottom: 1px solid #333">LaTeX It! run report:</div>
          <br style="line-height: 0">
          <div id="tblatex-log-closebutton" style="position: absolute;
              width: 34px; height: 34px; right: 0; top: 0;
              cursor: pointer; user-select: none">
            <svg style="width: 12px; height: 12px; position: absolute;
                top: 14px; right: 14px" fill="black" viewBox="0 0 96 96">
              <path d="M 55,48 96,7 89,0 48,41 7,0 0,7 41,48 0,89 7,96 48,55
                  89,96 96,89 Z"/>
            </svg>
          </div>
          <div id="tblatex-log-output" style="font-family: monospace;
              max-height: 300px; overflow: auto;
              margin: 0.5em 0 0; padding-right: 0.5em"></div>`;

      let body = editorDocument.querySelector("body");
      body.insertBefore(logNode, body.firstChild);

      let closeButtonNode = logNode.querySelector("#tblatex-log-closebutton");
      closeButtonNode.addEventListener("click", close);
    }

    function close() {
      let logNode = GetCurrentEditor().document.querySelector("#tblatex-log");
      if (logNode) logNode.remove();
    }

    function startThread() {
      threadCount.value += 1;
      return module(threadCount.value);
    }

    function write(message, options = {}, thread, debug = false) {
      let prefDebug = prefs.getBoolPref("debug");
      let editorDocument = GetCurrentEditor().document;
      let outputNode = editorDocument.querySelector("#tblatex-log-output");

      if (options.type == "critical") {
        if (!outputNode) {
          open(true);
          outputNode = editorDocument.querySelector("#tblatex-log-output");
        }
      } else {
        if ((debug && !prefDebug) || !outputNode) return null;
      }

      /* Apply options (1/3): Set default options. */
      let entryEdit = null;
      let appearence = {
        type: null,
        prefix: (prefDebug ? "*** " : ""),
        color: ""
      };

      /* Apply options (2/3): Override default options with those from
       * the handle of a previous log entry, if submitted. */
      ["replace", "append"].forEach(editMethod => {
        if (options[editMethod] instanceof Entry) {
          entryEdit = {method: editMethod, ...options[editMethod]};
        }
      });
      if (entryEdit) {
        if (entryEdit.method == "append") {
          message = entryEdit.message + message;
        }
        ["type", "prefix", "color"].forEach(property => {
          if (entryEdit[property] != null) {
            appearence[property] = entryEdit[property];
          }
        });
      }

      /* Apply options (3/3): Override with options that are explicitly
         set for the new log entry. */
      if (["default", "success", "failure", "warning", "critical"]
          .includes(options.type)) {
        appearence.type = options.type;
      }
      let hasPrefix = (prefDebug || options.prefix === true) &&
          !["", false].includes(options.prefix);
      if (["default", "warning"].includes(appearence.type)) {
        appearence.prefix = hasPrefix ? "*** " : "";
      } else if (["success", "failure"].includes(appearence.type)) {
        appearence.prefix = hasPrefix ? "--> " : "";
      } else if (appearence.type == "critical") {
        appearence.prefix = "!!! ";
      }
      if (appearence.type == "default") {
        appearence.color = "";
      } else if (appearence.type == "success") {
        appearence.color = "#089e19";
      } else if (appearence.type == "warning") {
        appearence.color = "#ae34eb";
      } else if (["failure", "critical"].includes(appearence.type)) {
        appearence.color = "#f00000";
      }
      if (typeof options.prefix == "string" && options.prefix.length <= 4) {
        appearence.prefix = options.prefix.padEnd(4);
      }
      if (typeof options.color == "string") {
        appearence.color = options.color;
      } else if (options.color === false) {
        appearence.color = "";
      }

      /* Nested structure is necessary:
         - All lines of the message but the first are indented. For this
           to work, the message must not start with a blank line.
         - Leading/trailing blank lines belong to this message and should be
           affected when editing the entry. Place them inside the entry node
           but above/below the inner div which holds the message. */
      let node = editorDocument.createElement("div");
      node.classList.add("entry");
      node.innerHTML =
          '<div style="margin: 0.2em 0; white-space: pre-wrap"></div>';
      let messageNode = node.querySelector("div");
      if (appearence.color) {
        messageNode.style.color = appearence.color
      }
      if (prefDebug) {
        messageNode.style.textIndent = "-4ch"
        messageNode.style.paddingLeft = "4ch";
      }

      /* Insert the entry node into the log at the correct place. */
      if (entryEdit) {
        if (entryEdit.node.dataset.thread) {
          node.dataset.thread = entryEdit.node.dataset.thread;
        }
        entryEdit.node.replaceWith(node);
      } else if (thread) {
        node.dataset.thread = thread;
        let threadNodes =
            outputNode.querySelectorAll("[data-thread='" + thread + "']");
        if (threadNodes.length) {
          threadNodes[threadNodes.length - 1].after(node);
        } else {
          outputNode.appendChild(node);
        }
      } else {
        outputNode.appendChild(node);
      }

      const createLineBreak = (className) => {
        let lineBreak = editorDocument.createElement("br");
        if (className) lineBreak.className = className;
        lineBreak.style = "line-height: 0.8";
        return lineBreak;
      };

      let lines = message.split(/\r?\n/g);

      /* Certain message types call for additional blank lines. */
      if (appearence.type == "critical") {
        lines.unshift("");
        lines.push("");
      }

      /* Place leading/trailing blank lines above/under message node. */
      while (lines[0] == "") {
        lines.shift();
        if (node == outputNode.firstElementChild) continue;
        messageNode.before(createLineBreak("above"));
      }
      while (lines[lines.length - 1] == "") {
        lines.pop();
        messageNode.after(createLineBreak("below"));
      }

      /* Write message. */
      if (lines[0]) lines[0] = appearence.prefix + lines[0];
      lines.forEach(line => {
        if (line) messageNode.appendChild(editorDocument.createTextNode(line));
        messageNode.appendChild(createLineBreak());
      });

      /* Hide trailing blank lines of last entry. */
      outputNode.querySelectorAll(".entry:not(:last-child) > br.below.hidden")
          .forEach(brNode => {
        brNode.style.display = "";
        brNode.classList.remove("hidden");
      })
      outputNode.querySelectorAll(".entry:last-child > br.below")
          .forEach(brNode => {
        brNode.style.display = "none";
        brNode.classList.add("hidden");
      })

      outputNode.lastElementChild.scrollIntoView(false);

      return new Entry({
        message: message,
        node: node,
        type: options.type,
        prefix: options.prefix,
        color: options.color
      });
    };

    function enableCloseButton() {
      let closeButtonNode = GetCurrentEditor().document
          .querySelector("#tblatex-log-closebutton");
      if (closeButtonNode) closeButtonNode.addEventListener("click", close);
    }

    function module(thread) {
      return {
        open: () => open(false),
        close: close,
        write: (message, options) =>
            write(message, options, thread, false),
        writeDebug: (message, options) =>
            write(message, options, thread, true),
        startThread: startThread,
        enableCloseButton: enableCloseButton
      };
    }

    return module();

  })();


  let busyIcon = {

    insert: function() {

      let editorDocument = GetCurrentEditor().document;

      let iconNode = editorDocument.createElement("div");
      iconNode.id = "tblatex-busy-icon";
      iconNode.style = `
          position: fixed; z-index: 999; border-radius: 14px;
          width: 64px; height: 64px; left: calc(50% - 32px);
          top: calc(50% - 32px);background: rgba(0, 0, 0, 0.5);
          box-shadow: 1px 1px 4px rgba(0, 0, 0, 0.5)`;
      iconNode.innerHTML = `
          <svg viewBox="0 0 256 256" style="color: white; position: absolute;
              width: 32px; height: 32px; top: 16px; left: 16px;
              animation: 1s linear infinite tblatex-busy-icon-animation">
            <defs>
              <mask id="tblatex-busy-icon-mask">
                <rect width="100%" height="100%" fill="white"/>
                <circle r="112" cx="135" cy="128" fill="black"/>
              </mask>
            </defs>
            <circle fill="currentColor" r="116" cx="119" cy="128"
                mask="url(#tblatex-busy-icon-mask)"/>
          </svg>`;

      let styleNode = editorDocument.createElement("style");
      styleNode.id = "tblatex-busy-icon-style";
      styleNode.innerHTML = `
          @keyframes tblatex-busy-icon-animation {
              0% { transform: rotate(  0deg) }
            100% { transform: rotate(360deg) }
          }`;

      let body = editorDocument.querySelector("body");
      body.insertBefore(iconNode, body.firstChild);

      let head = editorDocument.querySelector("head");
      head.appendChild(styleNode);
    },

    remove: function() {
      let editorDocument = GetCurrentEditor().document;
      editorDocument.querySelector("#tblatex-busy-icon").remove();
      editorDocument.querySelector("#tblatex-busy-icon-style").remove();
    }
  };


  function replace_marker(string, replacement) {
    var marker = "__REPLACE_ME__";
    var oldmarker = "__REPLACEME__";
    var len = marker.length;
    var i = string.indexOf(marker);
    if (i < 0) {
      // Look for old marker
      i = string.indexOf(oldmarker);
      if (i < 0) {
        throw new Error("Could not find the placeholder '" + marker +
            "' in your template.\nThis would be the place where " +
            "your LaTeX expression is inserted.\nPlease edit your " +
            "template and add this placeholder.");
        return null;
      } else {
        len = oldmarker.length;
      }
    }
    var p1 = string.substring(0, i);
    var p2 = string.substring(i+len);
    return p1 + replacement + p2;
  }


  /**
   * Converts a color given as "rgb(<r>, <g>, <b>)" or
   * "rgba(<r>, <g>, <b>, <a>)" to an array [<r>, <g>, <b>].
   */
  function cssComputedColorToRgbArray(cssComputedColor, log) {
    let fontColorByChannel = cssComputedColor.match(/\d+(\.\d+)?/g) || [];
    if (![3, 4].includes(fontColorByChannel.length)) {
      log.write("Unable to determine font color, defaulting to black.");
      fontColorByChannel = [0, 0, 0];
    }
    return fontColorByChannel;
  }


  /**
   * Converts a blob to a base64 encoded data URL. Returns a promise.
   */
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      let reader = new FileReader;
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }


  /**
   * Replaces a LaTeX text node with the corresponding generated image.
   */
  async function replaceLatexNode(latexNode, editor, template, log) {

    log.write("\nFound expression: " + latexNode.textContent);

    let latexDocument = replace_marker(template, latexNode.textContent);
    log.writeDebug("\nGenerated LaTeX document:\n" + latexDocument);

    let nodeStyle = window.getComputedStyle(latexNode.parentElement);
    let fontSizePx = nodeStyle.fontSize;
    let fontColor = cssComputedColorToRgbArray(nodeStyle.color, log);

    let [statusCode, imgFilePath, depth, height, width] =
        await run_latex(latexDocument, fontSizePx, fontColor, log);

    let logEntry = log.writeDebug("Replacing node...",
        {type: "success", color: false});

    let imgDataUrl = await fetch("file://" + imgFilePath,
            {headers: {'Content-Type': 'image/png'}})
        .then(response => response.blob())
        .then(blobToDataUrl);

    let imgNode = editor.createElementWithDefaults("img");
    imgNode.src = imgDataUrl;
    imgNode.alt = latexNode.nodeValue;
    imgNode.style.verticalAlign = -depth + "px";
    if (height && width) {
      imgNode.height = Math.round(height);
      imgNode.width = Math.round(width);
      imgNode.style.height = height + "px";
      imgNode.style.width = width + "px";
    }
    latexNode.replaceWith(imgNode);

    push_undo_func(() => imgNode.replaceWith(latexNode));

    log.writeDebug(" done.", {append: logEntry, type: "success"});

    return statusCode;
  }


  class ThreadLimiter {

    constructor() {
      this.maxRunningThreads = navigator.hardwareConcurrency;
      this.numRunningThreads = 0;
      this.queuedThreads = [];
    }

    async call(func, ...args) {
      if (this.numRunningThreads >= this.maxRunningThreads) {
        await new Promise((resolve, reject) => {
          this.queuedThreads.push(resolve);
        });
      }
      this.numRunningThreads += 1;
      return func(...args)
          .then(result => {
            if (this.queuedThreads.length) this.queuedThreads.shift()();
            this.numRunningThreads -= 1;
            return result;
          });
    }
  }


  tblatex.on_latexit = async function (event, silent) {
    /* safety checks */
    if (event.button == 2) return;
    var editor_elt = document.getElementById("content-frame");
    if (editor_elt.editortype != "htmlmail") {
      alert("Cannot compile LaTeX in plain text emails.\n\nTo open the " +
          "message compose window in HTML mode, hold down\nthe 'Shift' " +
          "key while pressing the 'Write'/'Reply'/... button.\n\nThe " +
          "default compose mode can be changed in the account settings.");
      return;
    }
    var editor = GetCurrentEditor();
    editor.flags |= editor.eEditorReadonlyMask;
    editor.beginTransaction();
    log.close();
    if (!silent) log.open();
    var body = editor_elt.contentDocument.getElementsByTagName("body")[0];
    let latexNodes = prepareLatexNodes(body);
    if (!latexNodes.length) {
      log.write("No unconverted LaTeX expression found.");
    } else {
      busyIcon.insert();
      let template = prefs.getCharPref("template");
      let threadLimiter = new ThreadLimiter();
      try {
        let exitCodes = await Promise.all(latexNodes.map(node => {
          return threadLimiter.call(
              replaceLatexNode, node, editor, template, log.startThread())
        }));
        let hasWarnings = false;
        exitCodes.forEach(code => { if (code > 0) hasWarnings = true; });
        if (hasWarnings) {
          log.write("\nAll LaTeX expressions have been compiled, " +
              "but there were errors.", {type: "warning"});
        } else {
          log.write("\nAll LaTeX expressions successfully converted.");
        }
      } catch(e) {
        let logEntry = log.write(e.message, {type: "critical"});
        log.writeDebug("\n\n" + e.stack, {append: logEntry});
        errorToConsole(e);
      }
      busyIcon.remove();
    }
    editor.endTransaction();
    editor.flags &= ~editor.eEditorReadonlyMask;
  };

  tblatex.on_middleclick = function(event) {
    // Return on all but the middle button
    if (event.button != 1) return;

    if (event.shiftKey) {
      // Undo all
      undo_all();
    } else {
      // Undo
      undo();
    }
    event.stopPropagation();
  };

  tblatex.on_undo = function (event) {
    undo();
    event.stopPropagation();
  };

  function undo() {
    let editor = GetCurrentEditor();
    editor.beginTransaction();
    if (g_undo_func) g_undo_func();
    editor.endTransaction();
  }

  tblatex.on_undo_all = function (event) {
    undo_all();
    event.stopPropagation();
  };

  function undo_all() {
    let editor = GetCurrentEditor();
    editor.beginTransaction();
    while (g_undo_func) {
      g_undo_func();
    }
    editor.endTransaction();
  };

  var g_complex_input = null;

  tblatex.on_insert_complex = function (event) {
    var editor = GetCurrentEditor();
    var f = async function (latex_expr, autodpi, font_size) {
      g_complex_input = latex_expr;
      busyIcon.insert();
      editor.beginTransaction();
      try {
        log.open();
        log.writeDebug("Entered LaTeX document:\n" + latex_expr);
        let anchorNode = editor.selection.anchorNode;
        if (anchorNode.nodeType == Node.TEXT_NODE) {
          anchorNode = anchorNode.parentElement;
        }
        let nodeStyle = window.getComputedStyle(anchorNode);
        let fontSizePx = autodpi ? nodeStyle.fontSize : font_size + "px";
        let fontColor = cssComputedColorToRgbArray(nodeStyle.color);
        let [st, url, depth, height, width] =
            await run_latex(latex_expr, fontSizePx, fontColor, log);

        if (st == 0 || st == 1) {

          let logEntry = log.writeDebug("Inserting at cursor position...",
              {type: "success", color: false});

          var img = editor.createElementWithDefaults("img");
          var reader = new FileReader();
          var xhr = new XMLHttpRequest();

          xhr.addEventListener("load",function() {
            reader.readAsDataURL(xhr.response);
          },false);

          reader.addEventListener("load", function() {
            editor.insertElementAtSelection(img, true);

            img.alt = latex_expr;
            img.title = latex_expr;
            img.src = reader.result;
            img.style.verticalAlign = -depth + "px";
            if (height && width) {
              img.height = Math.round(height);
              img.width = Math.round(width);
              img.style.height = height + "px";
              img.style.width = width + "px";
            }

            push_undo_func(() => img.remove());
            log.writeDebug(" done.", {append: logEntry, type: "success"});

            if (st > 0) {
              log.write("\nThe LaTeX document has been compiled, " +
                  "but there were errors.", {type: "warning"});
            } else {
              log.write("\nLaTeX document successfully converted.");
            }
          }, false);

          xhr.open('GET',"file://"+url);
          xhr.responseType = 'blob';
          xhr.overrideMimeType("image/png");
          xhr.send();
        } else {
            log.writeDebug("Failed, not inserting.", {type: "failure"});
        }
      } catch (e) {
        let message = "Error while trying to insert the LaTeX document:\n";
        errorToConsole(e, message);
        let logEntry = log.write(message + e.message, {type: "critical"});
        log.writeDebug("\n\n" + e.stack, {append: logEntry});
      }
      editor.endTransaction();
      busyIcon.remove();
    };
    var template = g_complex_input || prefs.getCharPref("template");
    var selection = editor.selection.toString();
    window.openDialog("chrome://tblatex/content/insert.xhtml", "", "chrome, resizable=yes", f, template, selection);
    event.stopPropagation();
  };

  tblatex.on_open_options = function (event) {
    window.openDialog("chrome://tblatex/content/options.xhtml", "", "");
    event.stopPropagation();
  };

  function check_log_report () {

    var editor = document.getElementById("content-frame");
    var edocument = editor.contentDocument;
    let logNode = edocument.getElementById("tblatex-log");

    if (!logNode) return true;

    let prompt = Services.prompt;
    let buttonFlags = prompt.BUTTON_TITLE_IS_STRING *
        (prompt.BUTTON_POS_0 + prompt.BUTTON_POS_1 + prompt.BUTTON_POS_2);
    /* Buttons will be displayed in the order 0-2-1.
       Pressing the prompt's close button also returns 1. */
    let pressedButton = prompt.confirmEx(
      window,
      "LaTeX It!",
      "There is a run report in your message.",
      buttonFlags,
      "Send",
      "Cancel",
      "Remove report and send",
      null,
      {}
    );
    switch (pressedButton) {
      case 0:
        let logCloseButtonNode =
            logNode.querySelector("#tblatex-log-closebutton");
        if (logCloseButtonNode) logCloseButtonNode.remove();
        return true;
      case 2:
        logNode.remove();
        return true;
      default:
        return false;
    }
  }


  /* Is this even remotey useful ? */
  /* Yes, because we can disable the toolbar button and menu items for plain text messages! */
  tblatex.on_load = async function () {
    // Override original send functions (this follows the approach from the "Check and Send" add-on
    tblatex.SendMessage_orig = SendMessage;
    SendMessage = function() {
      if (check_log_report())
          tblatex.SendMessage_orig.apply(this, arguments);
    }

    // Ctrl-Enter
    tblatex.SendMessageWithCheck_orig = SendMessageWithCheck;
    SendMessageWithCheck = function() {
      if (check_log_report())
          tblatex.SendMessageWithCheck_orig.apply(this, arguments);
    }

    tblatex.SendMessageLater_orig = SendMessageLater;
    SendMessageLater = function() {
      if (check_log_report())
          tblatex.SendMessageLater_orig.apply(this, arguments);
    }

    var tb = document.getElementById("composeToolbar2");
    tb.setAttribute("defaultset", tb.getAttribute("defaultset")+",tblatex-button-1");

    // wait for editortype being available (max 20 x 20ms)
    for (let i=0; i < 20; i++) {
      let editor_elt = document.getElementById("content-frame");
      if (editor_elt.editortype) {
       break;
      }
      await sleep(20);
    }

    // Disable the button and menu for non-html composer windows
    let editor_elt = document.getElementById("content-frame");
    if (editor_elt.editortype != "htmlmail") {
      var btn = document.getElementById("tblatex-button-1");
      if (btn) {
          btn.tooltipText = "Start a message in HTML format (by holding the 'Shift' key) to be able to turn every $...$ into a LaTeX image"
          btn.disabled = true;
      }
      for (var id of ["tblatex-context", "tblatex-context-menu"]) {
        var menu = document.getElementById(id);
        if (menu)
          menu.disabled = true;
      }
    }

    // Enable the close button of an existing log (e.g. in a draft email).
    const editorCreationObserver = (subject, topic, data) => {
      if (topic == "obs_documentCreated") log.enableCloseButton();
    }
    GetCurrentCommandManager()
        .addCommandObserver(editorCreationObserver, "obs_documentCreated");
  }

  tblatex.on_unload = function() {
    // Revert Patch
    SendMessage = tblatex.SendMessage_orig;
    SendMessageWithCheck = tblatex.SendMessageWithCheck_orig;
    SendMessageLater = tblatex.SendMessageLater_orig;

    // Remove all cached images on closing the composer window
    if (!prefs.getBoolPref("keeptempfiles")) {
      for (let key in g_image_cache) {
        let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        try {
          file.initWithPath(g_image_cache[key].path);
          file.remove(false);
        } catch (e) {
          let message = "Error while trying to remove " +
              "this temporary file:\n" + file.path;
          errorToConsole(e, message);
          log.writeDebug(message, {type: "warning"});
        }
      }
      g_image_cache = {};
    }
  }
})()
