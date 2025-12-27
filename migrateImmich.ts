//#region Imports and initial types
import { readFileSync, writeFileSync } from "node:fs";
import {
  init,
  createTag,
  getAllTags,
  uploadAsset,
  checkExistingAssets,
  createStack,
  tagAssets,
  createAlbum,
  AssetMediaStatus,
  Error as ImmichError,
  getAlbumInfo,
  addAssetsToAlbum,
} from "@immich/sdk";
import z from "zod";

const fs = {
  readFileSync,
  writeFileSync,
};

enum StepsAllowedToRun {
  CreateTags = 1,
  Assets = 2,
  TagAssets = 3,
  Stacks = 4,
  Albums = 5,
}

type ProgressTrackerSaved = {
  interrupted?: boolean;
  stepsCompleted?: StepsAllowedToRun[];
  /**Map old asset IDs to new ones if we need to complete follow up steps out of order */
  assetMap?: Record<string, string>;
  /**Map of old tag IDs to new ones */
  tagMap?: Record<string, string>;
  /**Map old tag IDs to parents and old asset IDs */
  tagFwdMap?: Record<string, Tag>;
  /**Map of old album IDs to new ones */
  albumMap?: Record<string, string>;
  /**Map of old stack IDs to new ones */
  stackMap?: Record<string, string>;
  /**Map of old stack IDs to new asset IDs */
  stackStaging?: Record<string, string[]>;
  /**List of assets that can't upload for one reason or another */
  problemAssets?: Record<string, "">;
  trashedAssets?: Record<string, true>;
  /**Stacks that are known to be a problem */
  problemStacks?: Record<string, "">;
};

type ProgressTracker = Required<ProgressTrackerSaved>;

const userConfigSchema = z.object({
  apiKey: z.string(),
  oldUserID: z.guid(),
});

const usersConfigSchema = z.record(z.string(), userConfigSchema);

const configSchema = z.object({
  userToMigrate: z.string().nonoptional(),
  intendedStepsToRun: z.array(z.enum(StepsAllowedToRun)),
  locationOfDBFiles: z.string(),
  locationOfDataset: z.string(),
  apiBaseURL: z.url(),
  users: usersConfigSchema,
});

const baseProgressTracker: Required<ProgressTrackerSaved> = {
  interrupted: false,
  stepsCompleted: [],
  assetMap: {},
  tagMap: {},
  tagFwdMap: {},
  albumMap: {},
  stackMap: {},
  stackStaging: {},
  problemAssets: {},
  trashedAssets: {},
  problemStacks: {},
};
//#endregion

//#region Config
const config = configSchema.parse(fs.readFileSync("./config.json"));

const userToMigrate = config.userToMigrate;
const userInfo = config.users[userToMigrate];
if (!userInfo) {
  throw new Error(
    `Selected user '${userToMigrate}' does not have a configuration in config.json`
  );
}
const oldUserID = userInfo.oldUserID;
const apiKey = userInfo.apiKey;
const intendedStepsToRun = z
  .array(z.enum(StepsAllowedToRun))
  .parse(config.intendedStepsToRun);
const locationOfDBFiles = config.locationOfDBFiles;
const locationOfDataset = config.locationOfDataset;
const apiBaseURL = config.apiBaseURL;
const progressFile = `${locationOfDBFiles}\\staging\\${userToMigrate}_progress.json`;

init({ baseUrl: apiBaseURL, apiKey });
//#endregion

//#region Collect progress
console.log("Preparing to migrate user: " + userToMigrate);

//This is a readonly operation, but "w+" allows the progress tracker to be gracefully created if it doesn't exist and still read in the current state
const progressSaved: ProgressTrackerSaved = JSON.parse(
  fs.readFileSync(progressFile, { flag: "w+" }).toString()
);

const progress: ProgressTracker = {
  ...baseProgressTracker,
  ...progressSaved,
};

if (progress.interrupted) {
  console.log("Previous run for this user was interrupted due to an exception");
  progress.interrupted = false;
}

const stepsToRun = intendedStepsToRun.filter(
  (s) => !progress.stepsCompleted.includes(s)
);

if (stepsToRun.length < intendedStepsToRun.length) {
  console.log("Configuration had steps that have already been completed");
}
//#endregion

//#region Build stacks
console.log("Building asset stacks");
const oldStacksList = fs
  .readFileSync(`${locationOfDBFiles}\\asset stacks.txt`)
  .toString()
  .split("\r\n");
//schema line
oldStacksList.shift();

//Need to track the old stack ID to match them up below, and the primary asset ID to know when to unshift
const oldStacks = new Map<string, string>();
//Old stackID with the list of new asset IDs
const stackStaging = new Map<string, string[]>(
  Object.entries(progress.stackStaging)
);
if (
  !progress.stepsCompleted.includes(StepsAllowedToRun.Stacks) &&
  stackStaging.values().next().value
) {
  console.log("Stacks were previously staged that were not finished");
}

for (const stackLine of oldStacksList) {
  //This is the last line anyway
  if (stackLine.trim() === "") {
    continue;
  }

  const [stackID, primaryAssetID, _] = stackLine.split("\t");
  if (!stackID || !primaryAssetID) {
    throw new Error("Following stack line failed to parse:\n" + stackLine);
  }

  //Skip this stack if its already been migrated
  if (stackStaging.has(stackID)) {
    continue;
  }

  oldStacks.set(stackID, primaryAssetID);
}

//#endregion

//#region Build albums
console.log("Getting list of albums");
const oldAlbumsList = fs
  .readFileSync(`${locationOfDBFiles}\\albums.txt`)
  .toString()
  .split("\r\n");
//schema line
oldAlbumsList.shift();

const oldAlbumMap = new Map<
  string,
  {
    albumName: string;
    description: string | undefined;
    /**Old Asset IDs*/ assets: Set<string>;
  }
>();

for (var albumLine of oldAlbumsList) {
  //This is the last line anyway
  if (albumLine.trim() === "") {
    continue;
  }

  const [
    albumID,
    ownerID,
    albumName,
    _createdAt,
    _thumbnailID,
    _updatedAt,
    description,
    ..._
  ] = albumLine.split("\t");
  //Description is ok to be undefined
  if (!albumID || !ownerID || !albumName) {
    throw new Error("Following album line failed to parse:\n" + albumLine);
  }

  if (ownerID.toLowerCase() !== oldUserID.toLowerCase()) {
    continue;
  }

  oldAlbumMap.set(albumID, {
    albumName,
    description,
    assets: new Set<string>(),
  });
}

//Now map the old asset IDs to their containing album to reconstruct the albums once we have the new asset IDs

console.log("Building old albums");
const filesInOldAlbumsList = fs
  .readFileSync(`${locationOfDBFiles}\\files in albums.txt`)
  .toString()
  .split("\r\n");
//schema line
filesInOldAlbumsList.shift();

for (const fileLine of filesInOldAlbumsList) {
  //This is the last line anyway
  if (fileLine.trim() === "") {
    continue;
  }

  const [albumID, oldAssetID, _] = fileLine.split("\t");
  if (!albumID || !oldAssetID) {
    throw new Error("Following album asset line failed to parse:\n" + fileLine);
  }

  //Albums not in the map are likely for someone else
  if (!oldAlbumMap.has(albumID)) {
    continue;
  }

  //If we picked this up as trashed on a previous run, we can skip it now
  if (progress.trashedAssets[oldAssetID]) {
    continue;
  }

  oldAlbumMap.get(albumID)!.assets.add(oldAssetID);
}
//#endregion

//#region Build tags
console.log("Building list of tags");

type Tag = { name: string; parentID: string | null; assets: string[] };

const tagFwdMap = new Map<string, Tag>(Object.entries(progress.tagFwdMap));

//Tagging assets will start to delete from the progress tracker, so if all assets and tags have been created, don't try to rebuild the map
if (
  progress.stepsCompleted.includes(StepsAllowedToRun.Assets) &&
  progress.stepsCompleted.includes(StepsAllowedToRun.CreateTags)
) {
  console.log("Tag mapping skipped due to existing progress");
} else {
  //Wait to read in the list of tags until now to reduce memory usage since this will go out of scope and be GC'ed;
  const oldTagsList = fs
    .readFileSync(`${locationOfDBFiles}\\tags.txt`)
    .toString()
    .split("\r\n");
  //schema line
  oldTagsList.shift();
  for (const tagLine of oldTagsList) {
    //This is the last line anyway
    if (tagLine.trim() === "") {
      continue;
    }

    const [tagID, userID, name, ..._] = tagLine.split("\t");
    if (!tagID || !userID || !name) {
      throw new Error("Following tag line failed to parse:\n" + tagLine);
    }

    if (userID.toLowerCase() !== oldUserID.toLowerCase()) {
      continue;
    }

    if (tagFwdMap.has(tagID)) {
      continue;
    }

    //parentIDs appear to be a NOT NULL column, so tag closure is needed to know which ones actually have a parent
    tagFwdMap.set(tagID, { name, parentID: null, assets: [] });
  }

  console.log("Building tag hierarchy");
  const tagsHierarchy = fs
    .readFileSync(`${locationOfDBFiles}\\tags closure.txt`)
    .toString()
    .split("\r\n");
  //schema line
  tagsHierarchy.shift();

  for (const relation of tagsHierarchy) {
    //This is the last line anyway
    if (relation.trim() === "") {
      continue;
    }

    const [ancestor, decendent] = relation.split("\t");
    if (!ancestor || !decendent) {
      throw new Error(
        "Following tag hierarchy line failed to parse:\n" + relation
      );
    }

    //Parents with no children will be their own ancestor, but also all tags are their own??
    if (ancestor.toLowerCase() === decendent.toLowerCase()) {
      continue;
    }

    //Skip this relation if the tag has already been created
    if (progress.tagMap[decendent]) {
      continue;
    }

    const tag = tagFwdMap.get(decendent);
    //Tag is likely for another user or was already migrated
    if (!tag) {
      continue;
    }

    tag.parentID = ancestor;
    tagFwdMap.set(decendent, tag);
  }

  console.log("Getting assets for tags");
  const taggedAssetList = fs
    .readFileSync(`${locationOfDBFiles}\\tags assets.txt`)
    .toString()
    .split("\r\n");
  //schema line
  taggedAssetList.shift();

  for (const taggedAssetLine of taggedAssetList) {
    //This is the last line anyway
    if (taggedAssetLine.trim() === "") {
      continue;
    }

    const [assetID, tagID] = taggedAssetLine.split("\t");
    if (!assetID || !tagID) {
      throw new Error(
        "Following asset tag line failed to parse:\n" + taggedAssetLine
      );
    }

    const tag = tagFwdMap.get(tagID);
    if (!tag) {
      continue;
    }
    const existingAssets = new Set(tag.assets);
    existingAssets.add(assetID);
    tag.assets = Array.from(existingAssets.keys());
    tagFwdMap.set(tagID, tag);
  }
}
//#endregion

//#region Load asset list
console.log("Loading list of assets");
//Do it this way to help cut down on the memory usage
const assets = (() => {
  const allAssets = fs
    .readFileSync(`${locationOfDBFiles}\\assets.txt`)
    .toString()
    .split("\r\n");

  //Schema line
  allAssets.shift();
  return allAssets.filter((assetLine) => {
    if (!assetLine.trim()) {
      return false;
    }
    const [_oldAssetID, _deviceAssetID, oldOwnerID, ..._] =
      assetLine.split("\t");
    return oldOwnerID?.toLowerCase() === oldUserID.toLowerCase();
  });
})();
//#endregion

//#region Server resources
console.log("Gathering existing resources (not assets)");

const existingTags = await getAllTags();
//#endregion

console.log("Preparation complete");

console.log(String.raw`
  Tags: ${tagFwdMap.size}
  Albums: ${oldAlbumMap.size}
  Stacks: ${oldStacks.size}
  Assets: ${assets.length}
  `);

//#region Migration helpers
const saveProgress = () => {
  const progressToSave: ProgressTracker = {
    ...progress,
    tagFwdMap: Object.fromEntries(tagFwdMap.entries()),
    stackStaging: Object.fromEntries(stackStaging.entries()),
  };

  fs.writeFileSync(progressFile, JSON.stringify(progressToSave));
};

const writeProgressLine = (message: string) => {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(message);
};

const addToStackMap = (
  newAssetID: string,
  oldAssetID: string,
  stackID: string
) => {
  if (oldStacks.has(stackID)) {
    if (!stackStaging.has(stackID)) {
      stackStaging.set(stackID, []);
    }

    const stack = stackStaging.get(stackID)!;

    const primaryAssetID = oldStacks.get(stackID)!;
    if (oldAssetID === primaryAssetID) {
      stack.unshift(newAssetID);
    } else {
      stack.push(newAssetID);
    }

    stackStaging.set(stackID, stack);
  }
};
//#endregion

let assetsCreated = 0;
let duplicateAssets = 0;
let inProgressTracker = 0;
let trashedAssets = 0;
let assetError = false;
//#region Asset helper
const uploadAssets = async (typeToUpload: "IMAGE" | "VIDEO") => {
  for (const assetLine of assets) {
    const [
      oldAssetID,
      deviceAssetId,
      _oldOwnerID,
      deviceId,
      type,
      fileDataPath,
      fileCreatedAt,
      fileModifiedAt,
      _isFavorite,
      _duration,
      _encodedVideoPath,
      _checksum,
      _isVisible,
      livePhotoVideoId,
      _serverModifiedAt,
      _serverCreatedAt,
      _isArchived,
      filename,
      sidecarPath,
      _thumbhash,
      _isOffline,
      _libraryId,
      _isExternal,
      _deletedAt,
      _localDateTime,
      stackID,
      _duplicateId,
      status,
      _updateId,
    ] = assetLine.split("\t");

    if (
      !oldAssetID ||
      !deviceAssetId ||
      !deviceId ||
      !fileDataPath ||
      !fileCreatedAt ||
      !fileModifiedAt ||
      !livePhotoVideoId ||
      !filename ||
      !sidecarPath ||
      !status
    ) {
      throw new Error("Following asset line failed to parse:\n" + assetLine);
    }

    //Pre-filtered by owner

    if (type !== typeToUpload) {
      continue;
    }

    try {
      if (progress.assetMap[oldAssetID]) {
        z.uuid().parse(progress.assetMap[oldAssetID]);
      }
    } catch {
      delete progress.assetMap[oldAssetID];
    }

    if (
      progress.assetMap[oldAssetID] &&
      progress.assetMap[oldAssetID] !== "NONE"
    ) {
      inProgressTracker++;
      writeProgressLine(
        `Assets created: ${assetsCreated} / ${
          assets.length - 1 - duplicateAssets
        }; Duplicates per server: ${duplicateAssets}; Uploaded per tracker: ${inProgressTracker}; Trashed assets: ${trashedAssets}`
      );
      if (progress.problemAssets[oldAssetID] !== undefined) {
        delete progress.problemAssets[oldAssetID];
      }

      if (stackID) {
        addToStackMap(progress.assetMap[oldAssetID], oldAssetID, stackID);
      }
      continue;
    }
    if (status === "trashed") {
      trashedAssets++;
      progress.trashedAssets[oldAssetID] = true;
      writeProgressLine(
        `Assets created: ${assetsCreated} / ${
          assets.length - 1 - duplicateAssets
        }; Duplicates per server: ${duplicateAssets}; Uploaded per tracker: ${inProgressTracker}; Trashed assets: ${trashedAssets}`
      );
      if (progress.problemAssets[oldAssetID] !== undefined) {
        delete progress.problemAssets[oldAssetID];
      }

      continue;
    }

    if (deviceAssetId !== "NONE") {
      const existingAssets = await checkExistingAssets({
        checkExistingAssetsDto: {
          deviceAssetIds: [deviceAssetId],
          deviceId: deviceId,
        },
      });
      if (existingAssets.existingIds.length) {
        if (
          !progress.assetMap[oldAssetID] &&
          existingAssets.existingIds[0] !== "NONE"
        ) {
          try {
            z.uuid().parse(existingAssets.existingIds[0]);
            progress.assetMap[oldAssetID] = existingAssets.existingIds[0]!;
            duplicateAssets++;

            writeProgressLine(
              `Assets created: ${assetsCreated} / ${
                assets.length - 1 - duplicateAssets
              }; Duplicates per server: ${duplicateAssets}; Uploaded per tracker: ${inProgressTracker}; Trashed assets: ${trashedAssets}`
            );
            if (progress.problemAssets[oldAssetID] !== undefined) {
              delete progress.problemAssets[oldAssetID];
            }

            if (stackID && existingAssets.existingIds[0]) {
              addToStackMap(existingAssets.existingIds[0], oldAssetID, stackID);
            }

            continue;
          } catch {
            //Don't do anything just try to reupload it again
          }
        }
      }
    }

    let updatedLivePhotoVideoId: string | undefined = undefined;
    if (livePhotoVideoId && livePhotoVideoId !== "\\N") {
      updatedLivePhotoVideoId = progress.assetMap[livePhotoVideoId];
      if (
        updatedLivePhotoVideoId === undefined ||
        updatedLivePhotoVideoId === "NONE"
      ) {
        throw new Error(
          `Video for live photo does not exist for: ${filename} (${livePhotoVideoId})`
        );
      }
    }

    let newAssetID: string | undefined = undefined;
    try {
      //Chop off the initial "upload" since the dataset is that folder, and the folder also has an extra s
      const assetData = fs.readFileSync(
        `${locationOfDataset}\\${fileDataPath
          .substring(7)
          .replace("upload", "uploads")
          .replace("encoded-video", "encoded_videos")}`
      );
      const sidecarData =
        sidecarPath === "\\N"
          ? undefined
          : fs.readFileSync(
              `${locationOfDataset}\\${sidecarPath
                .substring(7)
                .replace("upload", "uploads")
                .replace("encoded-video", "encoded_videos")}`
            );

      const { id, status } = await uploadAsset(
        {
          assetMediaCreateDto: {
            deviceAssetId:
              deviceAssetId === "NONE"
                ? Date.now() + "-" + assetData.length
                : deviceAssetId,
            fileCreatedAt,
            fileModifiedAt,
            filename,
            deviceId,
            ...(updatedLivePhotoVideoId
              ? { livePhotoVideoId: updatedLivePhotoVideoId }
              : {}),
            assetData: new File([assetData], filename),
            ...(sidecarData
              ? { sidecarData: new File([sidecarData], "", { type: "xmp" }) }
              : {}),
            metadata: [],
          },
        },
        { keepalive: true }
      );
      newAssetID = id;
      if (newAssetID === "NONE") {
        console.log("Status: " + status);
        throw new Error(`Old asset ID "${oldAssetID}" returned NONE`);
      }
      if (status === AssetMediaStatus.Duplicate) {
      }
    } catch (e: any) {
      console.log();
      console.log("Error uploading asset: " + oldAssetID);
      console.log("Type: " + typeToUpload);
      console.log("Asset path: " + fileDataPath);
      console.log("Sidecar path: " + sidecarPath);
      console.log("LivePhotoVideoID: " + livePhotoVideoId);
      console.log("Error: " + e?.toString());
      if (e?.cause) {
        console.log("Cause: " + e.cause);
      }
      console.log();
      assetError = true;
      progress.problemAssets[oldAssetID] = "";
      continue;
    }

    //The way this is structured, this has to exist if we get here
    newAssetID = newAssetID!;
    try {
      z.uuid().parse(newAssetID);
    } catch {
      throw new Error(
        `Old Asset ${oldAssetID} returned non-UUID ID ${newAssetID}`
      );
    }

    progress.assetMap[oldAssetID] = newAssetID;

    if (stackID && newAssetID) {
      addToStackMap(newAssetID, oldAssetID, stackID);
    }

    assetsCreated++;
    writeProgressLine(
      `Assets created: ${assetsCreated} / ${
        assets.length - 1 - duplicateAssets
      }; Duplicates per server: ${duplicateAssets}; Uploaded per tracker: ${inProgressTracker}; Trashed assets: ${trashedAssets}`
    );
  }
};
//#endregion

//#region Main block
try {
  //This can be buggy, if you know that everything created successfully on a previous run, just add the step to the progress tracker file
  //#region CreateTags
  if (stepsToRun.includes(StepsAllowedToRun.CreateTags)) {
    console.log("Running tags step");
    console.log("Building tag graph");
    //Create the base tags
    const tagDraftGraph: Record<string, any> = {};
    //Get list of all parents
    tagFwdMap.forEach((value, key) => {
      if (value.parentID) {
        if (tagDraftGraph[value.parentID]) {
          tagDraftGraph[value.parentID][key] = {};
        } else {
          tagDraftGraph[value.parentID] = { [key]: {} };
        }
      } else {
        if (!tagDraftGraph[key]) {
          tagDraftGraph[key] = {};
        }
      }
    });

    const tagGraph: Record<string, Record<string, Record<string, object>>> = {};
    //Tags (for us), have a maximum depth of 2 (<year>/<folder> or People/<person>)
    //Could do this truly recursively
    Object.keys(tagDraftGraph).forEach((key) => {
      const value = tagDraftGraph[key];
      if (JSON.stringify(value) === "{}") {
        tagGraph[key] = {};
        return;
      }
      Object.keys(value).forEach((subKey) => {
        const subValue = tagDraftGraph[key][subKey];
        if (JSON.stringify(subValue) === "{}") {
          if (tagGraph[key]) {
            tagGraph[key][subKey] = {};
          } else {
            tagGraph[key] = { [subKey]: {} };
          }
          return;
        }
        Object.keys(subValue).forEach((subSubKey) => {
          if (!tagGraph[key]) {
            tagGraph[key] = {};
          }

          if (tagGraph[key][subKey]) {
            tagGraph[key][subKey][subSubKey] = {};
          } else {
            tagGraph[key][subKey] = { [subSubKey]: {} };
          }
        });
      });
    });

    //Hopefully all tags in order of what needs to be created first
    const tagsToCreate = Object.entries(tagGraph).flatMap(([tagID, values]) =>
      [
        tagID,
        Object.entries(values).flatMap(([tagID, values]) =>
          [tagID, Object.keys(values)].flat()
        ),
      ].flat()
    );

    console.log(`Tags created: 0 / ${tagsToCreate.length - 1}`);
    let tagsCreated = 0;
    let tagsSkipped = 0;
    for (const tag of tagsToCreate) {
      const { name, parentID } = tagFwdMap.get(tag)!;
      const existingTag = existingTags.find((t) => name.includes(t.name));
      if (existingTag) {
        tagsSkipped++;
        progress.tagMap[tag] = existingTag.id;
        writeProgressLine(
          `Tags created: ${tagsCreated} / ${
            tagsToCreate.length - tagsSkipped
          }; Tags skipped: ${tagsSkipped}`
        );
        continue;
      }

      const newTag = await createTag({
        tagCreateDto: {
          name,
          parentId: parentID ? progress.tagMap[parentID] : null,
        },
      });

      tagsCreated++;
      progress.tagMap[tag] = newTag.id;
      writeProgressLine(
        `Tags created: ${tagsCreated} / ${
          tagsToCreate.length - tagsSkipped
        }; Tags skipped: ${tagsSkipped}`
      );
    }
    console.log();
    if (tagsCreated + tagsSkipped === tagsToCreate.length) {
      progress.stepsCompleted.push(StepsAllowedToRun.CreateTags);
    }
  }
  //#endregion

  //#region Assets
  if (stepsToRun.includes(StepsAllowedToRun.Assets)) {
    //Do video run first for live photos
    console.log(`Assets created: 0 / ${assets.length - 1}`);
    await uploadAssets("VIDEO");
    await uploadAssets("IMAGE");
    if (assetError) {
      throw new Error("Some assets were not uploaded, try again");
    }
    if (
      duplicateAssets + assetsCreated + inProgressTracker + trashedAssets ===
      assets.length
    ) {
      progress.stepsCompleted.push(StepsAllowedToRun.Assets);
    }
  }
  //#endregion

  //All of the following steps are only allowed to be completed when assets are complete to ensure completeness
  if (progress.stepsCompleted.includes(StepsAllowedToRun.Assets)) {
    //#region Stacks
    if (stepsToRun.includes(StepsAllowedToRun.Stacks)) {
      let stacksCreated = 0;
      let stacksSkipped = 0;
      console.log();
      console.log(
        `Stacks created: 0 / ${stackStaging.size}; Stacks skipped: ${stacksSkipped}`
      );
      for (const stack of stackStaging) {
        if (progress.stackMap[stack[0]]) {
          stacksSkipped++;
          writeProgressLine(
            `Stacks created: ${stacksCreated} / ${
              stackStaging.size - stacksSkipped
            }; Stacks skipped: ${stacksSkipped}`
          );
          continue;
        }

        if (progress.problemStacks[stack[0]] !== undefined) {
          continue;
        }

        if (stack[1].length < 2) {
          console.log();
          console.log(
            `Stack ID ${stack[0]} does not have enough assets to form a stack`
          );
          progress.problemStacks[stack[0]] = "";
          continue;
        }

        //Stacks are pre-filtered for previously trashed assets
        const { id } = await createStack({
          stackCreateDto: { assetIds: [...stack[1]] },
        });
        if (id && id !== "NONE") {
          progress.stackMap[stack[0]] = id;
          stacksCreated++;
          writeProgressLine(
            `Stacks created: ${stacksCreated} / ${
              stackStaging.size - stacksSkipped
            }; Stacks skipped: ${stacksSkipped}`
          );
        } else if (id === "NONE") {
          throw new Error(`Old stack ID "${stack[0]}" returned NONE`);
        } else {
          throw new Error(`Old stack ID "${stack[0]}" could not be created`);
        }
      }

      if (stacksCreated + stacksSkipped === stackStaging.size) {
        progress.stepsCompleted.push(StepsAllowedToRun.Stacks);
      }
    }
    //#endregion

    //#region TagAssets
    if (stepsToRun.includes(StepsAllowedToRun.TagAssets)) {
      let tagsPopulated = 0;
      console.log();
      console.log(
        `Tags populated with assets: ${tagsPopulated} / ${tagFwdMap.size}`
      );
      for (const tag of tagFwdMap) {
        const newTagID = progress.tagMap[tag[0]];
        if (!newTagID) {
          throw new Error(`Tag ${tag[0]} is unmapped in progress`);
        }
        //Albums are built before assets are loaded
        const oldAssets = tag[1].assets.filter(
          (a) => !progress.trashedAssets[a]
        );
        const newAssets = oldAssets
          .map((a) => {
            const newAssetID = progress.assetMap[a];
            if (newAssetID === "NONE") {
              return undefined;
            }
            return newAssetID;
          })
          .filter<string>((a): a is string => !!a);
        if (newAssets.length < oldAssets.length) {
          throw new Error("Assets missing for new tag " + newTagID);
        }

        const response = await tagAssets({
          id: newTagID,
          bulkIdsDto: { ids: newAssets },
        });

        if (
          response.some((t) => t.error && t.error !== ImmichError.Duplicate)
        ) {
          throw new Error(
            response
              .filter((r) => !!r.error)
              .map((r) => r.error)
              .join("\n")
          );
        }
        tagsPopulated++;
        writeProgressLine(
          `Tags populated with assets: ${tagsPopulated} / ${tagFwdMap.size}`
        );
      }
      if (tagsPopulated === Object.keys(progress.tagFwdMap).length) {
        progress.stepsCompleted[StepsAllowedToRun.TagAssets];
      }
    }
    //#endregion

    //#region Albums
    if (stepsToRun.includes(StepsAllowedToRun.Albums)) {
      let albumsCreated = 0;
      let albumsUpdated = 0;
      console.log();
      console.log(`Albums created: ${albumsCreated} / ${oldAlbumMap.size}`);
      for (const album of oldAlbumMap) {
        const oldAlbumID = album[0];
        const albumInfo = album[1];
        //Albums are built before assets are loaded, so have to wait to filter out previously deleted assets
        const oldAssetIDs = Array.from(albumInfo.assets.keys()).filter(
          (a) => !progress.trashedAssets[a]
        );
        const newAssetIDs = oldAssetIDs
          .map((a) => {
            const newAssetID = progress.assetMap[a];
            if (newAssetID === "NONE") {
              return undefined;
            }
            return newAssetID;
          })
          .filter((a): a is string => !!a);

        if (newAssetIDs.length < oldAssetIDs.length) {
          throw new Error(
            `Assets missing for album "${albumInfo.albumName}" (${oldAlbumID})`
          );
        }

        if (progress.albumMap[oldAlbumID]) {
          albumsUpdated++;
          const { assets, id: newAlbumID } = await getAlbumInfo({
            id: progress.albumMap[oldAlbumID],
          });
          if (assets.length < newAssetIDs.length) {
            const [response] = await addAssetsToAlbum({
              id: newAlbumID,
              bulkIdsDto: { ids: newAssetIDs },
            });
            if (response?.success) {
              console.log("Assets updated for " + albumInfo.albumName);
            } else if (
              response?.error &&
              response.error !== ImmichError.Duplicate
            ) {
              console.log(
                "Assets could not be updated for " + albumInfo.albumName
              );
              console.log("Cause: " + response?.error);
            }
          }
          continue;
        }

        const { id } = await createAlbum({
          createAlbumDto: {
            albumName: albumInfo.albumName,
            description: albumInfo.description,
            assetIds: newAssetIDs,
          },
        });

        albumsCreated++;
        progress.albumMap[oldAlbumID] = id;
        writeProgressLine(
          `Albums created: ${albumsCreated} / ${oldAlbumMap.size}`
        );
      }

      if (albumsCreated + albumsUpdated === oldAlbumMap.size) {
        progress.stepsCompleted.push(StepsAllowedToRun.Albums);
      }
    }
    //#endregion
  }
} catch (e: unknown) {
  progress.interrupted = true;
  saveProgress();
  throw e;
}
//#endregion

saveProgress();

console.log();
console.log("Migration configuration executed");
