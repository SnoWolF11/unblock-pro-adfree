# Test WebSocket handshake to Discord gateway. Exit 0 = OK, 1 = fail.
$hostname = "gateway.discord.gg"
$port = 443
$timeoutMs = 12000
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $ar = $tcp.BeginConnect($hostname, $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($timeoutMs)) { $tcp.Close(); exit 1 }
    $tcp.EndConnect($ar)
    $stream = $tcp.GetStream()
    $ssl = New-Object System.Net.Security.SslStream($stream, $false, { $true })
    $ssl.ReadTimeout = $timeoutMs
    $ssl.WriteTimeout = $timeoutMs
    $ssl.AuthenticateAsClient($hostname)
    $key = [Convert]::ToBase64String((1..16 | ForEach-Object { Get-Random -Maximum 256 -Minimum 0 }) -as [byte[]])
    $req = "GET /?v=10&encoding=json HTTP/1.1`r`nHost: $hostname`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: $key`r`nSec-WebSocket-Version: 13`r`n`r`n"
    $buf = [System.Text.Encoding]::UTF8.GetBytes($req)
    $ssl.Write($buf, 0, $buf.Length)
    $readBuf = New-Object byte[] 512
    $read = $ssl.Read($readBuf, 0, 512)
    $ssl.Close()
    $tcp.Close()
    $resp = [System.Text.Encoding]::UTF8.GetString($readBuf, 0, $read)
    if ($resp -match "101") { exit 0 }
} catch {}
exit 1
