#!/usr/bin/env bash
set -Eeuo pipefail

# Parse a Docker Compose dotenv file without executing it as shell code.
# The parsed value is returned in ENV_VALUE and is never logged.
declare -Ag ENV_VALUES=()
ENV_VALUE=''

_trim_env_space() {
  local value="$1"
  value="${value#"${value%%[!$' \t']*}"}"
  value="${value%"${value##*[!$' \t']}"}"
  printf '%s' "$value"
}

_parse_env_value() {
  local value="$1" rest ch escaped parsed suffix
  ENV_VALUE=''
  value="${value#"${value%%[!$' \t']*}"}"

  if [[ "$value" == "'"* ]]; then
    rest="${value:1}"
    [[ "$rest" == *"'"* ]] || return 1
    parsed="${rest%%\'*}"
    suffix="${rest:${#parsed}+1}"
    [[ -z "${suffix//[$' \t']/}" || "$suffix" == \#* ]] || return 1
    ENV_VALUE="$parsed"
    return 0
  fi

  if [[ "$value" == '"'* ]]; then
    rest="${value:1}"
    parsed=''
    while [[ -n "$rest" ]]; do
      ch="${rest:0:1}"
      rest="${rest:1}"
      if [[ "$ch" == '"' ]]; then
        suffix="$rest"
        [[ -z "${suffix//[$' \t']/}" || "$suffix" == \#* ]] || return 1
        ENV_VALUE="$parsed"
        return 0
      elif [[ "$ch" == \\ ]]; then
        [[ -n "$rest" ]] || return 1
        escaped="${rest:0:1}"
        rest="${rest:1}"
        case "$escaped" in
          n) parsed+=$'\n' ;; r) parsed+=$'\r' ;; t) parsed+=$'\t' ;;
          '\\'|\") parsed+="$escaped" ;;
          *) parsed+="\\$escaped" ;;
        esac
      else
        parsed+="$ch"
      fi
    done
    return 1
  fi

  # Compose permits spaces in unquoted values. A # starts a comment only when
  # preceded by whitespace; trim surrounding whitespace after that.
  if [[ "$value" =~ ^(.*[[:space:]])#.*$ ]]; then value="${BASH_REMATCH[1]}"; fi
  ENV_VALUE="$(_trim_env_space "$value")"
}

load_env_file() {
  local file="$1" line number key value
  [[ -f "$file" ]] || { echo "Missing environment file: $file" >&2; return 1; }
  ENV_VALUES=()
  number=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    ((number+=1))
    line="${line%$'\r'}"
    [[ -z "${line//[$' \t']/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#"${line%%[!$' \t']*}"}"
    if [[ "$line" == export[[:space:]]* ]]; then line="${line#export}"; line="${line#"${line%%[!$' \t']*}"}"; fi
    if [[ ! "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      echo "Malformed environment entry at line ${number} (expected KEY=VALUE)." >&2
      return 1
    fi
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    if ! _parse_env_value "$value"; then
      echo "Malformed value for environment key ${key} at line ${number}." >&2
      return 1
    fi
    ENV_VALUES["$key"]="$ENV_VALUE"
  done < "$file"
}

env_value() {
  local key="$1" default="${2-}"
  if [[ ${ENV_VALUES[$key]+_} ]]; then ENV_VALUE="${ENV_VALUES[$key]}"; else ENV_VALUE="$default"; fi
}

validate_web_port() {
  local value="$1"
  [[ -n "$value" ]] || { echo 'Missing required configuration key: SENTINELOPS_WEB_PORT.' >&2; return 1; }
  [[ "$value" =~ ^[0-9]+$ ]] || { echo 'Invalid SENTINELOPS_WEB_PORT: expected an integer from 1024 to 65535.' >&2; return 1; }
  (( 10#$value >= 1024 && 10#$value <= 65535 )) || { echo 'Invalid SENTINELOPS_WEB_PORT: expected an integer from 1024 to 65535.' >&2; return 1; }
}
