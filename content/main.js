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

  function dumpCallStack(e) {
    let frame = e ? e.stack : Components.stack;
    while (frame) {
      dump("\n"+frame);
      frame = frame.caller;
    }
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


  /* This *has* to be global. If image a.png is inserted, then modified, then
   * inserted again in the same mail, the OLD a.png is displayed because of some
   * cache which I haven't found a way to invalidate yet. */
  var g_suffix = 1;

  /* Returns [st, src, depth] where:
   * - st is 0 if everything went ok, 1 if some error was found but the image
   *   was nonetheless generated, 2 if there was a fatal error
   * - src is the local path of the image if generated
   * - depth is the number of pixels from the bottom of the image to the baseline of the image
   * */
  function run_latex(latex_expr, font_px, font_color) {

    var st = 0;

    try {
      let deleteTempFiles = !prefs.getBoolPref("keeptempfiles");

      const initFile = (path, pathAppend = "") => {
        let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        try {
          file.initWithPath(path);
          file.append(pathAppend);
          return file;
        } catch (e) {
          writeLog("Failed initializing the following path:\n" + path,
              {type: "critical"});
          return {exists() { return false; }};
        }
      };

      let imgKey = latex_expr + font_px + font_color;
      if (g_image_cache[imgKey]) {
        let imgPath = g_image_cache[imgKey].path;
        if (initFile(imgPath).exists()) {
          let depth = g_image_cache[imgKey].depth;
          let logEntry = writeLog("Image was already generated.");
          writeLogDebug("Image was already generated (depth=" + depth +
              "):\n" + imgPath, {entry: logEntry, purpose: "replace"});
          return [0, imgPath, depth];
        } else {
          delete g_image_cache[imgKey];
        }
      }

      // Check if the LaTeX expression (that is, the whole file) contains the required packages.
      // At the moment, it checks for the minimum of
      // - \usepackage[active]{preview}
      // which must not be commented out.
      //
      // The 'preview' package is needed for the baseline alignment with the surrounding text
      // introduced in v0.7.x.
      //
      // If the package(s) cannot be found, an alert message window is shown, informing the user.
      var re = /^[^%]*\\usepackage\[(.*,\s*)?active(,.*)?\]{(.*,\s*)?preview(,.*)?}/m;
      var package_match = latex_expr.match(re);
      if (!package_match) {
        alert("The mandatory package 'preview' cannot be found in the " +
            "LaTeX document.\n\nPlease add the following line in the " +
            "preamble of your LaTeX template or complex expression:\n" +
            "\\usepackage[active,displaymath,textmath]{preview}\n\n" +
            "Note: The preview package is needed for the alignment of the " +
            "generated images with the surrounding text.");
        writeLog("The mandatory package 'preview' cannot be found in the " +
            "LaTeX document.\nPlease add the following line in the " +
            "preamble of your LaTeX template or complex expression:\n" +
            "\\usepackage[active,displaymath,textmath]{preview}\n" +
            "Note: The preview package is needed for the alignment of the " +
            "generated images with the surrounding text.",
            {type: "critical"});
        return [2, "", 0];
      }

      /* \u00a0 = non-breaking space. \u2011 = non-breaking hyphen. */
      let logHintAddonOptions = "☰ ➜ Add-ons ➜ LaTeX It!"
          .replace(/ /g, "\u00a0").replace(/-/, "\u2011");
      let latex_bin = initFile(prefs.getCharPref("latex_path"));
      if (!latex_bin.exists()) {
        alert("Cannot find the 'latex' executable.\n\n" +
            "Please make sure the correct path is set in the add-on's\n" +
            "options dialog (☰ ➜ Add-ons ➜ LaTeX It!).");
        writeLog("Cannot find the 'latex' executable. Please make sure " +
            "the correct path is set in the add-on's options dialog (" +
            logHintAddonOptions + ").", {type: "critical"});
        return [2, "", 0];
      }
      let dvipng_bin = initFile(prefs.getCharPref("dvipng_path"));
      if (!dvipng_bin.exists()) {
        alert("The 'dvipng' executable cannot be found.\n\n" +
            "Please make sure the correct path is set in the add-on's\n" +
            "options dialog (☰ ➜ Add-ons ➜ LaTeX It!).");
        writeLog("The 'dvipng' executable cannot be found. Please make sure " +
            "the correct path is set in the add-on's options dialog (" +
            logHintAddonOptions + ").", {type: "critical"});
        return [2, "", 0];
      }
      // Since version 0.7.1 we support the alignment of the inserted pictures
      // to the text baseline, which works as follows (see also
      // https://github.com/protz/LatexIt/issues/36):
      //   1. Have the LaTeX package preview available.
      //   2. Insert \usepackage[active,textmath]{preview} into the preamble of
      //      the LaTeX document.
      //   3. Run dvipng with the option --depth.
      //   4. Parse the output of the command for the depth value (a typical
      //      output is:
      //        This is dvipng 1.15 Copyright 2002-2015 Jan-Ake Larsson
      //        [1 depth=4]
      //   5. Return the depth value (in the above case 4) from
      //      'main.js:run_latex()' in addition to the values already returned.
      //   6. In 'content/main.js' replace all
      //      'img.style = "vertical-align: middle"' with
      //      'img.style = "vertical-align: -<depth>px"' (where <depth> is the
      //      value returned by dvipng and needs a - sign in front of it).
      // The problem lies in the step 4, because it looks like that it is not
      // possible to capture the output of an external command in Thunderbird
      // (https://stackoverflow.com/questions/10215643/how-to-execute-a-windows-command-from-firefox-addon#answer-10216452).
      // However it is possible to redirect the standard output into a temporary
      // file and parse that file: You need to call the command in an external
      // shell (or LatexIt! must call a special script doing the redirection,
      // which should also be avoided, because it requires installing this
      // script file).
      // Here we get the shell binary and the command line option to call an
      // external program.
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
        shellProcess.run(true, shellArgs, shellArgs.length);
        let shellPathQ = addQuotesIfWhitespace(shellBin.path);
        let argsQ = args.map(addQuotesIfWhitespace).join(" ");
        let cmd = isWindows ?
            shellPathQ + " /c \"cd /d " + dirQ + " && " + argsQ + "\"" :
            shellPathQ + " -c 'cd " + dirQ + " && " + argsQ + "'";
        writeLogDebug(
            "I ran (exit code " + shellProcess.exitValue + "):\n" + cmd);
        return shellProcess.exitValue;
      };

      var temp_dir = Components.classes["@mozilla.org/file/directory_service;1"].
        getService(Components.interfaces.nsIProperties).
        get("TmpD", Components.interfaces.nsIFile).path;

      let temp_file_noext;
      let imgFile;
      do {
        temp_file_noext = "tblatex-" + g_suffix++;
        imgFile = initFile(temp_dir, temp_file_noext + ".png");
      } while (imgFile.exists());

      let texFile = initFile(temp_dir, temp_file_noext + ".tex");
      if (texFile.exists()) texFile.remove(false);

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

      let exitValue = runShellCmdInDir(temp_dir, [
        latex_bin.path,
        "-interaction=batchmode",
        temp_file_noext + ".tex"
      ]);

      let logEntryLatexExitValue;
      if (exitValue) {
        st = 1;
        logEntryLatexExitValue = writeLog("LaTeX process returned " +
            exitValue + ". Proceeding anyway.", {type: "warning"});
      }

      let auxFile = initFile(temp_dir, temp_file_noext + ".aux");
      let dviFile = initFile(temp_dir, temp_file_noext + ".dvi");
      let logFile = initFile(temp_dir, temp_file_noext + ".log");

      if (deleteTempFiles) {
        auxFile.remove(false);
        logFile.remove(false);
      }

      if (!dviFile.exists()) {
        let message = "LaTeX did not output a .dvi file.";
        if (logFile.exists()) {
          message += "\nPlease examine its log to learn " +
              "what went wrong:\n" + logFile.path;
        }
        writeLog(message, {type: "critical"});
        return [2, "", 0];
      }

      if (logEntryLatexExitValue && logFile.exists()) {
        writeLog("\nTo see what LaTeX is unhappy about, " +
            "you can examine its log:\n" + logFile.path,
            {entry: logEntryLatexExitValue, purpose: "append"});
      }

      let png_file = initFile(temp_dir, temp_file_noext + ".png");
      let depth_file = initFile(temp_dir, temp_file_noext + "-depth.txt");

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
        writeLogDebug("Font size of surrounding text: " + font_px);
      } else {
        var font_size = prefs.getIntPref("font_px");
        writeLogDebug("Using font size of " +
            font_size + "px as set in preferences.");
      }
      var dpi = font_size * 72.27 / 10;

      writeLogDebug("Calculated resolution: " + dpi + "dpi");

      exitValue = runShellCmdInDir(temp_dir, [
        dvipng_bin.path,
        "--depth",
        "-D", dpi.toString(),
        "-T", "tight",
        "-fg", font_color,
        "-bg", "Transparent",
        "-z", "3",
        "-o", temp_file_noext + ".png",
        temp_file_noext + ".dvi",
        ">", temp_file_noext + "-depth.txt"
      ]);

      if (deleteTempFiles) dviFile.remove(false);

      if (exitValue) {
        writeLog("dvipng failed with exit code " + exitValue +
            ". Aborting.", {type: "critical"});
        return [2, "", 0];
      }

      let logEntryImgFile =
          writeLogDebug("Generated image:\n" + png_file.path);

      // Read the depth (distance between base of image and baseline) from the depth file
      if (!depth_file.exists()) {
        writeLog("dvipng did not output a depth file. " +
            "Continuing without alignment.");
        g_image_cache[imgKey] = {path: png_file.path, depth: 0};
        return [st, png_file.path, 0];
      }

      // https://developer.mozilla.org/en-US/docs/Archive/Add-ons/Code_snippets/File_I_O#Line_by_line
      // Open an input stream from file
      var istream = Components.classes["@mozilla.org/network/file-input-stream;1"].
                    createInstance(Components.interfaces.nsIFileInputStream);
      istream.init(depth_file, 0x01, 0444, 0);
      istream.QueryInterface(Components.interfaces.nsILineInputStream);

      // Read line by line and look for the depth information, which is contained in a line such as
      //    [1 depth=4]
      var re = /^\[[0-9] +depth=([0-9]+)\] *$/;
      var line = {}, hasmore;
      var depth = 0;
      do {
        hasmore = istream.readLine(line);
        var linematch = line.value.match(re);
        if (linematch) {
          // Matching line found, get depth information and exit loop
          depth = linematch[1];
          writeLogDebug("Generated image (depth=" + depth + "):\n" +
              png_file.path, {entry: logEntryImgFile, purpose: "replace"});
          break;
        }
      } while(hasmore);

      // Close input stream
      istream.close();
      
      if (deleteTempFiles) depth_file.remove(false);

      // Only delete the LaTeX file at this point, so that it's left on disk
      // in case of error.
      if (deleteTempFiles) texFile.remove(false);

      if (st == 0) {
        writeLog("Compilation successful.");
      } else if (st == 1) {
        writeLog("Compilation finished and an image has been produced, " +
            "but there were errors.", {type: "warning"});
      }
      g_image_cache[imgKey] = {path: png_file.path, depth: depth};
      return [st, png_file.path, depth];
    } catch (e) {
      /* alert("Severe error. Missing package?\n\nSolution:\n" +
          "\tWe left the .tex file there:\n\t\t" + texFile.path + "\n" +
          "\tTry to run 'latex' and 'dvipng --depth' on it by yourself..."); */
      dump(e+"\n");
      dump(e.stack+"\n");
      /* writeLog("Severe error. Missing package?\nWe left the .tex file " +
          "there: " + texFile.path + ", try to run 'latex' and 'dvipng " +
          "--depth' on it by yourself..." : ""), {type: "critical"}); */
      return [2, "", 0];
    }
  }


  /**
   * JavaScript's default alert() function does not allow setting a title.
   * Replace it with one provided by Thunderbird.
   */
  function alert(message) {
    Services.prompt.alert(window, "LaTeX It!", message);
  }


  /**
   * Writes a message to the log. Has to be unmuted first by calling
   * openLog(). Will be muted when calling closeLog().
   *
   * Takes one or two arguments: A message string and optionally a list of
   * options, i.e. an object literal which may have the following properties:
   *
   * - type: One of "default", "success", "failure", "warning", "critical".
   * Modifies line prefix, leading/trailing blank lines and color.
   *
   * - prefix: Overwrites the default behavior of only debug messages
   * having line prefixes. If ""/false/null, the line prefix will be removed.
   * If true, the prefix will be shown. If string of 1 to 4 characters length,
   * the String will be padded to 4 characters length and used as prefix.
   *
   * - color: Message color in CSS format. Unset by passing ""/false/null.
   *
   * - entry: The return value of a previous call to writeLog[Debug](),
   * representing this earlier log entry. To be used in combination with
   * option "purpose".
   *
   * - purpose: One of the following strings:
   * "after": Message is inserted separately after entry. (default)
   * "append": Message is appended to entry.
   * "replace": Message replaces entry.
   *
   * Precedence: Option "type" will overwrite appearence of a previous
   * log entry given by option "entry". Options "prefix" and "color" will
   * overwrite settings implied by options "type" and "entry".
   *
   * Returns an object {node, message[, type, prefix, color]} containing
   * the newly created or modified log entry node and the passed message
   * and options.
   */
  let writeLog = (message, options) => {};


  /**
   * Same as writeLog(), but will only write to
   * the log if the debug option is set.
   */
  let writeLogDebug = (message, options) => {};


  /**
   * Initiates logging by creating and inserting the log into the message
   * editor and unmuting the logging functions.
   */
  function openLog() {

    closeLog();

    if (!prefs.getBoolPref("log")) return;

    let edocument = document.getElementById("content-frame").contentDocument;

    let logNode = edocument.createElement("div");
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

    let body = edocument.querySelector("body");
    body.insertBefore(logNode, body.firstChild);

    let closeButtonNode = logNode.querySelector("#tblatex-log-closebutton");
    closeButtonNode.addEventListener("click", closeLog);

    let outputNode = logNode.querySelector("#tblatex-log-output");
    let prefDebug = prefs.getBoolPref("debug");

    writeLog = (message, options = {}) => {

      /* Apply options (1/3): Set default options. */
      let entry = null;
      let purpose = "after";
      let appearence = {
        type: null,
        prefix: (prefDebug ? "*** " : ""),
        color: ""
      };

      /* Apply options (2/3): Override default options with those from
         the handle of a previous log entry, if submitted. */
      if (options.entry &&
          typeof options.entry.message == "string" &&
          options.entry.node instanceof Element &&
          options.entry.node.closest("#tblatex-log")) {
        entry = options.entry.node;
        if (["after", "append", "replace"].includes(options.purpose)) {
          purpose = options.purpose;
        }
        ["type", "prefix", "color"].forEach(property => {
          if (options.entry.hasOwnProperty(property)) {
            appearence[property] = options.entry[property];
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
          !["", false, null].includes(options.prefix);
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
        appearence.color = "#c2a42b";
      } else if (["failure", "critical"].includes(appearence.type)) {
        appearence.color = "#f00000";
      }
      if (typeof options.prefix == "string" && options.prefix.length <= 4) {
        appearence.prefix = options.prefix.padEnd(4);
      }
      if (options.color && typeof options.color == "string") {
        appearence.color = options.color;
      } else if (["", false, null].includes(options.color)) {
        appearence.color = "";
      }

      /* Nested structure is necessary:
         - All lines of the message but the first are indented. For this
           to work, the message must not start with a blank line.
         - Leading/trailing blank lines belong to this message and should be
           affected when changing newEntry. Place them inside newEntry but
           above/below the inner div which holds the message. */
      let newEntry = edocument.createElement("div");
      newEntry.classList.add("entry");
      newEntry.innerHTML =
          '<div style="margin: 0.2em 0; white-space: pre-wrap"></div>';
      let messageNode = newEntry.querySelector("div");
      if (appearence.color) {
        messageNode.style.color = appearence.color
      }
      if (prefDebug) {
        messageNode.style.textIndent = "-4ch"
        messageNode.style.paddingLeft = "4ch";
      }

      if (!entry) {
        outputNode.appendChild(newEntry);
      } else if (purpose == "after") {
        entry.after(newEntry);
      } else if (purpose == "append") {
        message = options.entry.message + message;
        entry.replaceWith(newEntry);
      } else if (purpose == "replace") {
        entry.replaceWith(newEntry);
      }

      const createLineBreak = (className) => {
        let lineBreak = edocument.createElement("br");
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
        if (newEntry == outputNode.firstElementChild) continue;
        messageNode.before(createLineBreak("above"));
      }
      while (lines[lines.length - 1] == "") {
        lines.pop();
        messageNode.after(createLineBreak("below"));
      }

      /* Write message. */
      if (lines[0]) lines[0] = appearence.prefix + lines[0];
      lines.forEach(line => {
        if (line) messageNode.appendChild(edocument.createTextNode(line));
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

      let returnHandle = {message: message, node: newEntry};
      ["type", "prefix", "color"].forEach(property => {
        if (options.hasOwnProperty(property)) {
          returnHandle[property] = options[property];
        }
      });
      return returnHandle;
    };

    writeLogDebug = (...args) => {
      if (!prefDebug) {
        return null;
      } else {
        return writeLog(...args);
      }
    };
  }


  /**
   * Removes the log from the message editor and mutes the logging functions.
   */
  function closeLog() {
    writeLog = () => {};
    writeLogDebug = () => {};
    var editor = document.getElementById("content-frame");
    var edocument = editor.contentDocument;
    var logNode = edocument.getElementById("tblatex-log");
    if (logNode) logNode.remove();
  }


  function replace_marker(string, replacement) {
    var marker = "__REPLACE_ME__";
    var oldmarker = "__REPLACEME__";
    var len = marker.length;
    var i = string.indexOf(marker);
    if (i < 0) {
      // Look for old marker
      i = string.indexOf(oldmarker);
      if (i < 0) {
        writeLog("Could not find the placeholder '" + marker + "' in " +
            "your template.\nThis would be the place, where your LaTeX " +
            "expression is inserted.\nPlease edit your template and add " +
            "this placeholder.", {type: "critical"});
        return null;
      } else {
        len = oldmarker.length;
      }
    }
    var p1 = string.substring(0, i);
    var p2 = string.substring(i+len);
    return p1 + replacement + p2;
  }

  /* replaces each latex text node with the corresponding generated image */
  function replace_latex_nodes(nodes) {
    var template = prefs.getCharPref("template");
    var editor = GetCurrentEditor();

    for (var i = 0; i < nodes.length; ++i) (function (i) { /* Need a real scope here and there is no let-binding available in Thunderbird 2 */
      var elt = nodes[i];

      writeLog("\nFound expression: " + elt.nodeValue);

      var latex_expr = replace_marker(template, elt.nodeValue);

      writeLogDebug("\nGenerated LaTeX document:\n" + latex_expr);

      // Font size in pixels
      var font_px = window.getComputedStyle(elt.parentElement, null).getPropertyValue('font-size');
      // Font color in "rgb(x,y,z)" => "RGB x y z"
      var font_color = window.getComputedStyle(elt.parentElement, null).getPropertyValue('color').replace(/([\(,\)])/g, " ").replace("rgb", "RGB");
      var [st, url, depth] = run_latex(latex_expr, font_px, font_color);

      if (st == 0 || st == 1) {

        let logEntry = writeLogDebug(
            "Replacing node...", {type: "success", color: false});

        var img = editor.createElementWithDefaults("img");
        var reader = new FileReader();
        var xhr = new XMLHttpRequest();

        xhr.addEventListener("load",function() {
          reader.readAsDataURL(xhr.response);
        },false);

        reader.addEventListener("load", function() {
          elt.parentNode.insertBefore(img, elt);
          elt.parentNode.removeChild(elt);

          img.alt = elt.nodeValue;
          img.style = "vertical-align: -" + depth + "px";
          img.src = reader.result;

          push_undo_func(function () {
            img.parentNode.insertBefore(elt, img);
            img.parentNode.removeChild(img);
          });

          writeLogDebug(" done.",
              {entry: logEntry, purpose: "append", type: "success"});
        }, false);

        xhr.open('GET',"file://"+url);
        xhr.responseType = 'blob';
        xhr.overrideMimeType("image/png");
        xhr.send();
      } else {
        writeLogDebug("Failed, not inserting.", {type: "failure"});
      }
    })(i);
  }

  tblatex.on_latexit = function (event, silent) {
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
    editor.beginTransaction();
    try {
      silent ? closeLog() : openLog();
      var body = editor_elt.contentDocument.getElementsByTagName("body")[0];
      let latexNodes = prepareLatexNodes(body);
      if (!latexNodes.length) {
        writeLog("No unconverted LaTeX expression found.");
      } else {
        replace_latex_nodes(latexNodes);
      }
    } catch (e /*if false*/) { /*XXX do not catch errors to get full backtraces in dev cycles */
      Components.utils.reportError("TBLatex error: "+e);
      dump(e+"\n");
      dumpCallStack(e);
    }
    editor.endTransaction();
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
    var editor = GetCurrentEditor();
    editor.beginTransaction();
    try {
      if (g_undo_func)
        g_undo_func();
    } catch (e) {
      Components.utils.reportError("TBLatex Error (while undoing) "+e);
      dumpCallStack(e);
    }
    editor.endTransaction();
  }

  tblatex.on_undo_all = function (event) {
    undo_all();
    event.stopPropagation();
  };

  function undo_all() {
    var editor = GetCurrentEditor();
    editor.beginTransaction();
    try {
      while (g_undo_func)
        g_undo_func();
    } catch (e) {
      Components.utils.reportError("TBLatex Error (while undoing) "+e);
      dumpCallStack(e);
    }
    editor.endTransaction();
  };

  var g_complex_input = null;

  tblatex.on_insert_complex = function (event) {
    var editor = GetCurrentEditor();
    var f = function (latex_expr, autodpi, font_size) {
      g_complex_input = latex_expr;
      editor.beginTransaction();
      try {
        openLog();
        writeLogDebug("Entered LaTeX document:\n" + latex_expr);
        let elt = editor.selection.anchorNode.parentElement;
        if (autodpi) {
          // Font size at cursor position
          var font_px = window.getComputedStyle(elt).getPropertyValue('font-size');
        } else {
          var font_px = font_size+"px";
        }
        // Font color in "rgb(x,y,z)" => "RGB x y z"
        var font_color = window.getComputedStyle(elt).getPropertyValue('color').replace(/([\(,\)])/g, " ").replace("rgb", "RGB");
        var [st, url, depth] = run_latex(latex_expr, font_px, font_color);

        if (st == 0 || st == 1) {

          let logEntry = writeLogDebug("Inserting at cursor position...",
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
            img.style = "vertical-align: -" + depth + "px";
            img.src = reader.result;

            push_undo_func(function () {
              img.parentNode.removeChild(img);
            });
            writeLogDebug(" done.",
                {entry: logEntry, purpose: "append", type: "success"});
          }, false);

          xhr.open('GET',"file://"+url);
          xhr.responseType = 'blob';
          xhr.overrideMimeType("image/png");
          xhr.send();
        } else {
            writeLogDebug("Failed, not inserting.", {type: "failure"});
        }
      } catch (e) {
        Components.utils.reportError("TBLatex Error (while inserting) "+e);
        dumpCallStack(e);
      }
      editor.endTransaction();
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
  }

  tblatex.on_unload = function() {
    // Revert Patch
    SendMessage = tblatex.SendMessage_orig;
    SendMessageWithCheck = tblatex.SendMessageWithCheck_orig;
    SendMessageLater = tblatex.SendMessageLater_orig;

    // Remove all cached images on closing the composer window
    if (!prefs.getBoolPref("keeptempfiles")) {
      for (var key in g_image_cache) {
        var f = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
        try {
          f.initWithPath(g_image_cache[key].path);
          f.remove(false);
        } catch (e) {
          // The image file might suddenly be inaccessible. As it is located
          // in the temporary directory, we now depend on the OS to delete it
          // at a later time.
        }
      }
      g_image_cache = {};
    }
  }
})()
