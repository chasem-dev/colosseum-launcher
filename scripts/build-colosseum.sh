#!/bin/sh
# Builds the game in the game folder ($1): the decomp's build file once (the port reads its link lists),
# then the port's build.sh with its dependencies named (a newer port doesn't read SMS_PORT). The compilers and
# tools come from the launcher's build tools, through the environment it starts this with.
# COLO_GAME=xd builds Pokémon XD from deps/pkmn-xd instead; its build.sh prepares that decomp's build itself
# (from the disc's main.dol the launcher puts in the decomp's orig/GXXE01/sys).
set -e
root=$1
case "$COLO_GAME" in
    xd) decomp=pkmn-xd ;;
    *) decomp=pkmn-colosseum ;;
esac
export COLO_PORT="$root" DECOMP="$root/deps/$decomp" SMS_PORT="$root/deps/sms-pc-port"
if [ "$COLO_GAME" != xd ] && [ ! -f "$DECOMP/build.ninja" ]; then
    echo "Preparing the decomp's build"
    (cd "$DECOMP" && python3 configure.py > /dev/null)
fi
exec /bin/sh "$root/build.sh"
