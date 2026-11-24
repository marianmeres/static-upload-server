#!/usr/bin/env bash
set -euo pipefail

# Deploys a vX.Y.Z release by pulling the image CI built for it
# (.github/workflows/build-image.yml). Nothing is built on this host.
#
#   bash deploy.sh            # the latest vX.Y.Z tag
#   bash deploy.sh v2.1.0     # a given one (also how to roll back)
#
# Run it on the host, in the deployed clone, as a user that can run docker. The
# configuration is the `.env` beside docker-compose.yml, as for any `docker compose`
# command here.
#
# In order, stopping at the first failure:
#   1. fetch the tags and check out the one to deploy;
#   2. pull its image;
#   3. write the tag into `.env` as APP_IMAGE_TAG, so that a later plain
#      `docker compose up -d` (after editing `.env`, say) keeps running this release;
#   4. replace the container and wait until it reports healthy;
#   5. check that the server answers with the version the tag names.
#
# The running container is touched only in step 4. When the pull fails, the previous
# release keeps serving and `.env` still names it.
#
# This script is part of each release. When the tag being deployed carries a different
# version of it, that version takes over right after the checkout (step 1).

cd "$(dirname "${BASH_SOURCE[0]}")"

SERVICE=upload-server
ENV_FILE=.env
VERSION_TAG='^v[0-9]+\.[0-9]+\.[0-9]+$'

# The image the service's container runs now ("" when there is none).
running_image() {
	local id
	id="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
	if [ -n "$id" ]; then
		docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true
	fi
}

# The image docker-compose.yml names for a tag.
image_for() {
	APP_IMAGE_TAG="$1" docker compose config --images | head -1
}

# Set APP_IMAGE_TAG in .env (created when missing), or remove it when given "".
# Every other line stays as it is.
write_env_tag() {
	local tmp
	[ -f "$ENV_FILE" ] || [ -n "$1" ] || return 0
	tmp="$(mktemp)"
	if [ -f "$ENV_FILE" ]; then
		grep -Ev '^[[:space:]]*(export[[:space:]]+)?APP_IMAGE_TAG[[:space:]]*=' "$ENV_FILE" >"$tmp" || true
	fi
	if [ -n "$1" ]; then
		printf 'APP_IMAGE_TAG=%s\n' "$1" >>"$tmp"
	fi
	# into the existing file, so its owner and mode stay
	cat "$tmp" >"$ENV_FILE"
	rm -f "$tmp"
}

# ---- 1. the tag -------------------------------------------------------------

TAG="${1:-}"
git fetch --tags --quiet

if [ -z "$TAG" ]; then
	TAG="$(git tag --sort=-v:refname | grep -E "$VERSION_TAG" | head -1 || true)"
	if [ -z "$TAG" ]; then
		echo "Error: no vX.Y.Z tag found"
		exit 1
	fi
	echo "Latest tag: $TAG"
elif ! git rev-parse --verify --quiet "refs/tags/$TAG" >/dev/null; then
	echo "Error: tag $TAG not found"
	exit 1
fi

CURRENT="$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD)"

# The release to name for a rollback: the one the container runs now. Passed on by an
# earlier version of this script that handed over to this one (see below).
PREVIOUS="${DEPLOY_PREVIOUS:-}"
if [ -z "$PREVIOUS" ]; then
	running="$(running_image)"
	if [[ "${running##*:}" =~ $VERSION_TAG ]]; then
		PREVIOUS="${running##*:}"
	elif [[ "$CURRENT" =~ $VERSION_TAG ]]; then
		PREVIOUS="$CURRENT"
	fi
fi

if [ "$CURRENT" = "$TAG" ] && [ "$(running_image)" = "$(image_for "$TAG")" ]; then
	echo "$TAG is already deployed."
	read -r -p "Deploy it again? [y/N] " answer || answer=""
	if [[ ! "$answer" =~ ^[Yy]$ ]]; then
		exit 0
	fi
fi

if [ "$CURRENT" != "$TAG" ]; then
	FROM="$(git rev-parse HEAD)"
	echo "Checking out $TAG ..."
	git checkout --quiet "$TAG"
	if ! git diff --quiet "$FROM" HEAD -- deploy.sh; then
		# A release from before the image pipeline (2.0.0 and older) builds on the host
		# and ignores APP_IMAGE_TAG. Left in .env, a later deploy run by that release's
		# script would start the image it names, whatever tag it was asked for.
		if ! grep -q APP_IMAGE_TAG docker-compose.yml; then
			write_env_tag ""
		fi
		echo "$TAG carries another version of deploy.sh; continuing with that one."
		DEPLOY_PREVIOUS="$PREVIOUS" exec bash ./deploy.sh "$TAG"
	fi
fi

# ---- 2. pull ----------------------------------------------------------------

IMAGE="$(image_for "$TAG")"
echo "Pulling $IMAGE ..."
if ! APP_IMAGE_TAG="$TAG" docker compose pull --quiet "$SERVICE"; then
	cat <<EOF

Error: could not pull $IMAGE.
Nothing was replaced: the release that was running still is, and .env still names it.

  1. The image for $TAG may not be built yet, or its build failed: see the
     "Build and push image" workflow in the repository's Actions tab.
  2. If the package on GitHub is private, this host has to be logged in:
       docker login ghcr.io -u <github-user>     (a token with read:packages)

Then run this script again.
EOF
	exit 1
fi

# ---- 3. record the tag --------------------------------------------------------

write_env_tag "$TAG"
# The shell environment would win over .env, so set it here too.
export APP_IMAGE_TAG="$TAG"

# ---- 4. replace the container --------------------------------------------------

echo "Starting $TAG ..."
if ! docker compose up -d --force-recreate --wait --wait-timeout 60 "$SERVICE"; then
	echo
	echo "Error: the $TAG container did not become healthy. Its last log lines:"
	docker compose logs --tail 30 "$SERVICE" || true
	echo
	if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TAG" ]; then
		echo "Roll back with:  bash deploy.sh $PREVIOUS"
	fi
	exit 1
fi

# ---- 5. check the version -------------------------------------------------------

VERSION="$(docker compose exec -T "$SERVICE" node -e \
	"fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/').then((r)=>r.json()).then((j)=>console.log(j.version))" \
	2>/dev/null || true)"
if [ "$VERSION" != "${TAG#v}" ]; then
	echo "Error: $TAG was deployed, but the server reports version '${VERSION:-(none)}'."
	exit 1
fi

echo "Deployed $TAG (the server reports version $VERSION)."
docker compose ps "$SERVICE"
