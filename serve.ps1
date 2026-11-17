# Local static server: powershell -ExecutionPolicy Bypass -File serve.ps1
# Listens on loopback only. Other devices reach it through `tailscale serve`,
# which forwards the original Host header, so requests can't be filtered by hostname.
param([int]$Port = 5173, [switch]$Open)

$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
}

function Send-Response($stream, [string]$status, [string]$type, [byte[]]$body, [bool]$sendBody) {
  $length = if ($body) { $body.Length } else { 0 }
  $head = "HTTP/1.1 $status`r`nContent-Length: $length`r`nCache-Control: no-store`r`nConnection: close`r`n"
  if ($type) { $head += "Content-Type: $type`r`n" }
  $headBytes = [Text.Encoding]::ASCII.GetBytes($head + "`r`n")
  $stream.Write($headBytes, 0, $headBytes.Length)
  if ($sendBody -and $body) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Food wheel running at http://localhost:$Port/  (close this window to stop)"
if ($Open) { Start-Process "http://localhost:$Port/" }

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      # Requests are handled one at a time, so don't let an idle connection hold up the rest
      $stream.ReadTimeout = 1000
      $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII)
      $parts = "$($reader.ReadLine())".Split(' ')
      while ($reader.ReadLine()) { }

      $method = $parts[0]
      if ($parts.Length -lt 2 -or ($method -ne 'GET' -and $method -ne 'HEAD')) {
        Send-Response $stream '405 Method Not Allowed' $null $null $false
        continue
      }

      $path = [Uri]::UnescapeDataString($parts[1].Split('?')[0]).TrimStart('/')
      if ($path -eq '') { $path = 'index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path))
      $type = $types[[IO.Path]::GetExtension($file)]

      # Only web files inside this folder are served (not serve.ps1 or start.bat)
      if ($type -and $file.StartsWith($root + [IO.Path]::DirectorySeparatorChar) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
        Send-Response $stream '200 OK' $type ([IO.File]::ReadAllBytes($file)) ($method -eq 'GET')
      } else {
        Send-Response $stream '404 Not Found' $null $null $false
      }
    } catch {
      Write-Host "Request failed: $_"
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
