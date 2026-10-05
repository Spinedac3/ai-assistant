#!/usr/bin/env bash
# commit-msg hook: gitmoji shortcode + short subject, no assistant trailers.
# The format this repository has always used: `:recycle: applyJoinInfoToQuery`.
# Install once per clone (covers every worktree):
#   printf '#!/usr/bin/env bash\nexec bash "$(git rev-parse --show-toplevel)/tools/harness/commit-msg.sh" "$@"\n' > .git/hooks/commit-msg
set -u
file="$1"
subject=$(grep -v '^#' "$file" | tr -d '\r' | sed -n '1p')
body=$(grep -v '^#' "$file" | tr -d '\r')
fail() { printf 'commit-msg: %s\n  subject: %s\n' "$1" "$subject" >&2; exit 1; }

case "$subject" in
  Merge\ *|Revert\ *|fixup!\ *|squash!\ *) exit 0 ;;
esac

grep -qE '^:[a-z0-9_]+: [^ ]' <<<"$subject" \
  || fail 'expected `:gitmoji_shortcode: Short subject` — e.g. `:white_check_mark: FileTest`'

grep -qiE '^(co-authored-by:.*claude|claude-session:|.*generated with \[?claude)' <<<"$body" \
  && fail 'no assistant trailers in commits (Co-Authored-By / Generated with / Claude-Session)'

exit 0
