# Latex It!

A Thunderbird extension that converts LaTeX to inline images in the message
composer.

## Features

- Compile all LaTeX expressions `$...$`, `\(...\)` and `\[...\]` found in the
  email body. The images will be inserted automatically and aligned with the
  surrounding text.
- Automatically compile and insert an entire LaTeX document into your email.
- Undo LaTeX compilation.
- Customize the appearance of your formulae by editing the document template.
- Since everything is run on your own computer, you're in control!

## Build

This extension is provided as a set of files. Run make to build a working xpi.

## Known issues

- Undoing LaTeX compilation only succeeds as long as the original DOM node of
  the inserted image exists.
- The options panel is not accessible in Thunderbird 91 nightly.
