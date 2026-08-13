# clipboard.md — clipboard change sidecar for Windows.
#
# Emits one line per poll ONLY when the clipboard sequence number changes, plus one
# baseline line at startup. The parent reads the line and does the actual clipboard
# read itself; this process never touches the data.
#
# Why a sidecar rather than a timer in the app: the app would have to read the whole
# clipboard on every tick just to discover nothing had changed, and for an image that
# means a full PNG re-encode on the thread that must never block. This is the same
# shape as the macOS pasteboard watcher.
#
# Why GetClipboardSequenceNumber and NOT AddClipboardFormatListener or a poll that
# opens the clipboard: the sequence number is readable WITHOUT calling
# OpenClipboard. Anything that opens the clipboard on a timer is how a background
# tool becomes the reason Excel says "We couldn't free up space on the Clipboard" in
# somebody else's app. We must never be that tool.
#
# Line protocol (space-separated, stable — src/main/win/sequenceWatcher.ts parses it):
#   CLIP <sequence> <exclude> <history> <cloud>
# where the three flags are 0/1 for the presence of the clipboard formats password
# managers register to say "do not record this".

$ErrorActionPreference = 'Stop'

try {
  Add-Type -Namespace ClipMd -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetClipboardSequenceNumber();

[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern uint RegisterClipboardFormat(string lpszFormat);

[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsClipboardFormatAvailable(uint format);
'@
} catch {
  # Constrained Language Mode, AppLocker, or an EDR product blocking Add-Type. This
  # is not rare on managed machines. Exit non-zero: the parent treats an exit as
  # "fall back to polling", which is a worse experience but never a dead one.
  [Console]::Error.WriteLine("clipwatch: Add-Type blocked: $($_.Exception.Message)")
  exit 1
}

# Registered once. RegisterClipboardFormat returns the same id for a given name for
# the lifetime of the session, whether or not anyone has ever used it.
$fmtExclude = [ClipMd.Native]::RegisterClipboardFormat('ExcludeClipboardContentFromMonitorProcessing')
$fmtHistory = [ClipMd.Native]::RegisterClipboardFormat('CanIncludeInClipboardHistory')
$fmtCloud   = [ClipMd.Native]::RegisterClipboardFormat('CanUploadToCloudClipboard')

function Emit([uint32] $seq) {
  # The flags are read at the same instant as the sequence number, because they
  # describe THIS clipboard content — by the time the parent reads them back the
  # user may have copied something else.
  $e = if ([ClipMd.Native]::IsClipboardFormatAvailable($fmtExclude)) { 1 } else { 0 }
  $h = if ([ClipMd.Native]::IsClipboardFormatAvailable($fmtHistory)) { 1 } else { 0 }
  $c = if ([ClipMd.Native]::IsClipboardFormatAvailable($fmtCloud))   { 1 } else { 0 }
  [Console]::Out.WriteLine("CLIP $seq $e $h $c")
  # Without an explicit flush the parent sees nothing until the pipe buffer fills,
  # which for 30-byte lines is never — the watcher would look hung and time out.
  [Console]::Out.Flush()
}

$last = [ClipMd.Native]::GetClipboardSequenceNumber()
# Baseline: tells the parent we are alive and what is already on the clipboard, so
# it can prime without capturing it. The parent skips exactly one line for this.
Emit $last

while ($true) {
  Start-Sleep -Milliseconds 250
  $seq = [ClipMd.Native]::GetClipboardSequenceNumber()
  if ($seq -ne $last) {
    $last = $seq
    Emit $seq
  }
}
