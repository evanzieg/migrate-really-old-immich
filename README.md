# What is this for
This is specifically to help migrate the data for a TrueNAS installation of Immich from an existing instance to a new instance.

In my case, I had originally installed Immich in late 2024 and when trying to do an update, TrueNAS freaked out and prevented the upgrade and in trying to troubleshoot, I accidentally deleted the Postgres DB dataset and had to start completely fresh. As a result, I became extremely update adverse and kind of left it to languish until mid 2025. By then, the Immich team had executed a couple heavily breaking changes, and because of TrueNAS' "user friendly" interface, it was not possible to take my extremely old instance and just run it through all of the intermediate versions to apply the changes and migrate the instance.

Because the mobile app was completely broken at this point, my only solution was to make a fresh Immich instance. The web portal for the old instance still works, which will be useful for some album reconstructions, and critically it was still able to make DB backups.

# What do you need
* A text editor that can open extremely large text files (VS Code worked for me, but feel free to use whatever)
* A semi-recent Node installation (I don't believe a specific version should be necessary, but I built this with Node 25)
* Enough space on your server to re-upload all of your Immich assets
* A second Immich instance setup
    * You don't have to set it fully up right now, but you will need to make the datasets according to the Immich installation docs at minimum.

# TrueNAS setup
For the below steps, assume I am referring to your old Immich instance unless stated otherwise. These steps obtain the backup file we will be borrowing to power the script, and enabling the script to be able to find all of the files.
1. Login to your server
2. Navigate to the Shares page
3. Add a new share to your old instance with the "Default share parameters" Purpose
<img width="326" height="539" alt="image" src="https://github.com/user-attachments/assets/d4ff0d32-d9fb-419c-b2cf-6169b80a5c54" />

5. Ensure you have a dataset you can access normally (like a plain file share for yourself since you will need to open a file on your desktop/laptop)
6. Ensure you have an SMB share also set up for that dataset
7. The next step diverges slightly if you chose to use the built-in dataset for your `backups` dataset or if you made a "real" dataset for the backups, and if you want to add a new SMB share to do the upcoming copy manually. The instructions below will be to find the IXVolume if you used the built-in dataset.
    1. Go to Settings > Shell
    2. Enter the following command to move the current directory to the built in dataset. You may need to change the app name if you installed it under a different name
       * `cd /mnt/.ix-apps/app_mounts/immich/backups`
    3. Run  `ls` to list out the backups, you are looking for the newest one to use in the following step
    4. Run the following command replacing the backup file name with yours, and updating the second file path to point to the plain SMB share from before. We will be doing surgery on this file to power the script. I personally put everything in the `immichDB` subfolder to contain everything, but you can do whatever you want, as long as all of the files are created where they are expected.
       * `sudo cp immich-db-backup-1758520800014.sql.gz '/mnt/HDDs/evans stuff/immichDB/immich-db-backup-1758520800014.sql.gz' --reflink=never`
    5. Use a program like 7zip to unzip the backup file, or use `gzip -d` after navigating your terminal to the folder you just copied the backup to.

# Unpack the SQL backup
