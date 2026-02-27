@echo off
setlocal enabledelayedexpansion

:: Target directory for skills
set "SKILLS_DIR=src\skills"

if not exist "!SKILLS_DIR!" (
    echo [ERROR] Skills directory not found at !SKILLS_DIR!
    exit /b 1
)

echo [INFO] Repairing skill XML files in !SKILLS_DIR!...

powershell -NoProfile -Command ^
    "$files = Get-ChildItem -Path '!SKILLS_DIR!' -Filter *.xml;" ^
    "foreach ($file in $files) {" ^
        "$path = $file.FullName;" ^
        "$content = Get-Content $path -Raw;" ^
        "if ($content -match '<name>|<description>|<category>') {" ^
            "Write-Host \"Updating: $($file.Name)\";" ^
            "$name = if ($content -match '<name>(.*?)</name>') { $matches[1] } else { '' };" ^
            "$desc = if ($content -match '<description>(.*?)</description>') { $matches[1] } else { '' };" ^
            "$cat = if ($content -match '<category>(.*?)</category>') { $matches[1] } else { '' };" ^
            "$lang = if ($content -match '<language>(.*?)</language>') { $matches[1] } else { '' };" ^
            "$id = if ($content -match '<id>(.*?)</id>') { $matches[1] } else { '' };" ^
            "$body = $content -replace '<name>.*?</name>', '' " ^
                             "-replace '<description>.*?</description>', '' " ^
                             "-replace '<category>.*?</category>', '' " ^
                             "-replace '<language>.*?</language>', '' " ^
                             "-replace '<id>.*?</id>', '' " ^
                             "-replace '<timestamp>.*?</timestamp>', '' " ^
                             "-replace '<skill[^>]*>', '' " ^
                             "-replace '</skill>', '';" ^
            "$body = $body.Trim();" ^
            "$newXml = \"<skill title=`\"$name`\" description=`\"$desc`\" category=`\"$cat`\" language=`\"$lang`\" id=`\"$id`\">`n$body`n</skill>\";" ^
            "Set-Content $path $newXml -Encoding utf8;" ^
        "}" ^
    "}"

echo [SUCCESS] Skills formatting updated.
pause