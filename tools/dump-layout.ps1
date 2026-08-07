$ErrorActionPreference = 'Stop'
$a = [Reflection.Assembly]::LoadFrom('C:\Program Files (x86)\SimHub\GSIReader.dll')
$ts = @()
try { $ts = $a.GetTypes() } catch { $ts = $_.Exception.Types | Where-Object { $_ -ne $null } }
$models = $ts | Where-Object { $_.Namespace -eq 'GSIReader.Wreckfest2.Models' }

$out = @{ structs = @{}; enums = @{} }

foreach ($t in $models) {
  if ($t.IsEnum) {
    $vals = @{}
    foreach ($n in [Enum]::GetNames($t)) {
      $vals[$n] = [int64]([Enum]::Parse($t, $n) -as $t.GetEnumUnderlyingType())
    }
    $out.enums[$t.Name] = @{
      underlying = $t.GetEnumUnderlyingType().Name
      values     = $vals
    }
    continue
  }

  $entry = @{ isValueType = $t.IsValueType; fields = @() }
  try { $entry.size = [Runtime.InteropServices.Marshal]::SizeOf($t) }
  catch { $entry.size = -1; $entry.sizeError = $_.Exception.Message }

  $la = $t.StructLayoutAttribute
  if ($la -ne $null) { $entry.layout = $la.Value.ToString(); $entry.pack = $la.Pack }

  foreach ($f in $t.GetFields('Public,Instance')) {
    $fi = @{ name = $f.Name; type = $f.FieldType.Name }
    try { $fi.offset = [int]([Runtime.InteropServices.Marshal]::OffsetOf($t, $f.Name)) }
    catch { $fi.offset = -1 }

    foreach ($ca in $f.CustomAttributes) {
      if ($ca.AttributeType.Name -eq 'MarshalAsAttribute') {
        $fi.unmanagedType = $ca.ConstructorArguments[0].Value.ToString()
        foreach ($na in $ca.NamedArguments) {
          if ($na.MemberName -eq 'SizeConst')   { $fi.sizeConst   = [int]$na.TypedValue.Value }
          if ($na.MemberName -eq 'ArraySubType'){ $fi.arraySubType = $na.TypedValue.Value.ToString() }
        }
      }
    }
    $entry.fields += $fi
  }
  $out.structs[$t.Name] = $entry
}

$out | ConvertTo-Json -Depth 12 -Compress | Out-File -FilePath $args[0] -Encoding utf8
Write-Output ("structs=" + $out.structs.Count + " enums=" + $out.enums.Count)
