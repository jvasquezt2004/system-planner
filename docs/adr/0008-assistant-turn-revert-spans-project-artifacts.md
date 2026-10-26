# Revert Assistant changes across project artifacts together

An Assistant turn may edit the System design, architecture layout, linked database Designs, and Walkthroughs together, and its Revert covers all of those changes as one turn. Existing separate content histories are simpler locally, but would leave a request such as adding a worker, changing its database schema, and updating its Walkthrough only partly reverted. The Assistant can arrange architecture layouts when requested and otherwise preserves existing layout except where placement of new elements requires it.

Revert checks for conflicts with subsequent manual edits. When conflicts exist, it identifies affected items and leaves the Project unchanged until they are resolved, rather than discarding later work or partially reverting the turn. Independent edits elsewhere do not block Revert.

Ordinary Undo follows one Project-wide content history across views, with an Assistant turn treated as one undoable action. Useful typing and drag groups form individual actions; navigation, selection, pan, and zoom remain outside content history. Concurrent manual editing stays available: an Assistant edit based on changed relevant content must reread and adapt rather than overwrite intervening work, while independent changes may proceed.
