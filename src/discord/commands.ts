import { SlashCommandBuilder } from "discord.js";

export const commandBuilders = [
  new SlashCommandBuilder().setName("ping").setDescription("Check whether the bot is responsive."),
  new SlashCommandBuilder()
    .setName("record")
    .setDescription("Control Stage recording.")
    .addSubcommand((subcommand) =>
      subcommand.setName("start").setDescription("Start recording the Stage channel you are in."),
    )
    .addSubcommand((subcommand) => subcommand.setName("stop").setDescription("Stop the active recording."))
    .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Show active recording status.")),
];

export const commandJson = commandBuilders.map((command) => command.toJSON());
